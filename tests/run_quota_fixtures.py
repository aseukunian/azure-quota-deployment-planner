"""Run browser and generated CLI fixtures without Azure access or extra packages."""

import html
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
CHROME = os.environ.get("CHROME_BIN") or shutil.which("chromium") or shutil.which("google-chrome")
if not CHROME:
    CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if not Path(CHROME).is_file():
    raise SystemExit("Set CHROME_BIN to a Chrome/Chromium executable.")
for command in ("bash", "pwsh", "jq", "python3"):
    if not shutil.which(command):
        raise SystemExit(f"Required fixture tool missing: {command}")


FAKE_AZ = r'''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
def arg(name):
    return args[args.index(name)+1] if name in args else None
def metric(name="cores"):
    return {"name":{"value":name,"localizedValue":name},"currentValue":8,"limit":10,"unit":"Count"}
entry = {"args":args}
with open(os.environ["FIXTURE_LOG"],"a") as log:
    log.write(json.dumps(entry)+"\n")
sub = "00000000-0000-0000-0000-000000000001"
url = arg("--url") or ""
if args[:2] == ["account","list-locations"]:
    print("eastus\ntaiwannorth"); sys.exit()
if os.environ.get("FIXTURE_MODE") == "failure" and "Microsoft.ContainerInstance/" in url:
    print("Fixture endpoint denied",file=sys.stderr); sys.exit(1)
if args[:1] == ["rest"]:
    assert url.startswith("https://management.azure.com/")
    if "checkQuotaAvailability" in url:
        assert arg("--method") == "post"
        data = {"hostsRemaining":{"AV36":3,"AV20":0},"quotaEnabled":"Enabled"}
    else:
        assert arg("--method") == "get"
        if "/providers/Microsoft.Quota/quotas?" in url:
            data = {"value":[{"properties":{"name":{"value":"cores"},"limit":{"value":10},"unit":"Count"}}]}
        elif "/providers/Microsoft.Quota/usages?" in url:
            data = {"value":[{"properties":{"name":{"value":"cores"},"usages":{"value":8}}}]}
            if os.environ.get("FIXTURE_MODE") == "missing-quota-usage":
                data = {"value":[]}
        elif "automationAccounts?" in url:
            data = {"value":[{"id":f"/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Automation/automationAccounts/shared",
                              "name":"shared","location":region}
                             for rg,region in [("rg-one","eastus"),("rg-two","taiwannorth")]]}
        elif "/automationAccounts/" in url:
            data = {"value":[metric("subscriptionUsage"),metric("jobs")]}
        else:
            data = {"value":[metric()]}
            if "Microsoft.ContainerInstance/" in url and "page=2" not in url:
                data["nextLink"] = url+"&page=2"
                if os.environ.get("FIXTURE_MODE") == "cross-origin":
                    data["nextLink"] = "https://example.invalid/do-not-call"
                if os.environ.get("FIXTURE_MODE") == "cycle":
                    data["nextLink"] = url
                if os.environ.get("FIXTURE_MODE") == "invalid-counter":
                    data = {"value":[dict(metric(),currentValue=None)]}
            if "page=2" in url:
                data = {"value":[metric("secondPage")]}
                if os.environ.get("FIXTURE_MODE") == "malformed":
                    data = {"value":{}}
elif args[:2] == ["quota","list"]:
    data = [{"properties":{"name":{"value":"cores"},"limit":{"value":10},"usages":{"value":8},"unit":"Count"}}]
else:
    assert args[:2] in (["vm","list-usage"],["network","list-usages"])
    data = [metric()]
print(json.dumps(data))
'''


def browser(work, expression):
    app = (ROOT / "index.html").read_text()
    fixtures = (ROOT / "tests/quota-fixtures.js").read_text()
    runner = """
    <script>
    (async()=>{
      try {
        const result = await (EXPRESSION);
        const el=document.createElement("pre");el.id="fixture-result";
        el.textContent=JSON.stringify({ok:true,result});document.body.appendChild(el);
      } catch(e) {
        const el=document.createElement("pre");el.id="fixture-result";
        el.textContent=JSON.stringify({ok:false,error:e.message,stack:e.stack});document.body.appendChild(el);
      }
    })();
    </script>
    """.replace("EXPRESSION", expression)
    test_page = work / "fixtures.html"
    before, after = app.rsplit("</body>", 1)
    test_page.write_text(before + f"<script>{fixtures}</script>{runner}</body>" + after)
    completed = subprocess.run(
        [CHROME, "--headless", "--no-first-run", "--disable-background-networking",
         "--disable-default-apps", "--disable-gpu", f"--user-data-dir={work / 'chrome-profile'}",
         "--dump-dom", "--virtual-time-budget=30000", test_page.as_uri()],
        capture_output=True, text=True, timeout=60, check=True,
    )
    match = re.search(r'<pre id="fixture-result">(.*?)</pre>', completed.stdout, re.S)
    if not match:
        raise AssertionError("Browser fixture did not finish: " + completed.stderr[-1000:])
    result = json.loads(html.unescape(match[1]))
    if not result["ok"]:
        raise AssertionError(result)
    return result["result"]


with tempfile.TemporaryDirectory(prefix="quota-fixtures-") as directory:
    work = Path(directory)
    result = browser(work, "runQuotaFixtures()")
    print(f"PASS: {len(result['checks'])} browser contract/runtime checks")
    fake_bin = work / "bin"
    fake_bin.mkdir()
    az = fake_bin / "az"
    az.write_text(FAKE_AZ)
    az.chmod(0o755)
    outputs = {}
    for kind, command in (("bash", ["bash"]), ("ps", ["pwsh", "-NoLogo", "-NoProfile", "-NonInteractive", "-File"])):
        for mode in ("success", "discover", "failure", "malformed", "cross-origin", "cycle", "invalid-counter", "missing-quota-usage"):
            case = work / f"{kind}-{mode}"
            case.mkdir()
            script = case / ("collector.sh" if kind == "bash" else "collector.ps1")
            script.write_text(result["scriptsAll" if mode=="discover" else "scripts"][kind])
            env = dict(os.environ, PATH=str(fake_bin)+os.pathsep+os.environ["PATH"],
                       FIXTURE_LOG=str(case / "calls.jsonl"), FIXTURE_MODE=mode)
            completed = subprocess.run(command+[str(script)], cwd=case, env=env, capture_output=True, text=True, timeout=120)
            report = case / "quota-report.json"
            if mode not in ("success", "discover"):
                assert completed.returncode != 0 and not report.exists(), (kind, mode, completed.stdout, completed.stderr)
                print(f"PASS: {kind} {mode} stops export explicitly")
                continue
            assert completed.returncode == 0, (kind, completed.stdout, completed.stderr)
            records = json.loads(report.read_text(encoding="utf-8-sig"))
            assert isinstance(records, list) and all(isinstance(item, dict) for item in records)
            expected = {"compute","network","quota","appservice","storage","postgres","automation",
                        "aci","containerapps","devbox","search","devopspools","hdinsight","avs"}
            assert {item["sourceProvider"] for item in records} == expected
            calls = [json.loads(line)["args"] for line in (case / "calls.jsonl").read_text().splitlines()]
            urls = [args[args.index("--url")+1] for args in calls if "--url" in args]
            assert sum("automationAccounts?" in url for url in urls) == 1
            assert sum("page=2" in url for url in urls) == 2
            assert {item["location"] for item in records if item["sourceProvider"]=="automation"} == {"eastus","taiwannorth"}
            assert not any("quotaRequests" in url for url in urls)
            if mode=="discover":
                assert sum(args[:2]==["account","list-locations"] for args in calls)==1
            outputs[kind] = records
            print(f"PASS: {kind} {mode} executes all 14 providers, scopes and pagination ({len(records)} records)")
    for kind, records in outputs.items():
        expression = """Promise.resolve().then(()=>{
          const records=RECORDS;
          const imported=rowsFromImportArrays([records],"","");
          const scoped=imported.filter(r=>r.provider==="automation"&&r.scope!=="Subscription");
          if(scoped.length!==2||diffKey(scoped[0])===diffKey(scoped[1]))throw new Error("Offline scope collision");
          if(imported.filter(r=>r.provider==="automation"&&r.scope==="Subscription").length!==1)throw new Error("Subscription dedupe");
          if(!imported.some(r=>r.provider==="avs"&&r.remaining===0&&r.current===null))throw new Error("Lost remaining-only zero");
          if(new Set(imported.map(r=>r.provider)).size!==14)throw new Error("Lost service identity");
          return imported.length;
        })""".replace("RECORDS", json.dumps(records))
        count = browser(work, expression)
        print(f"PASS: {kind} generated JSON imports with all identities ({count} rows)")
