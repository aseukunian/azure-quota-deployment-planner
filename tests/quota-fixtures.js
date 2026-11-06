async function runQuotaFixtures(){
  const checks = [];
  function check(name, condition){
    if(!condition) throw new Error(name);
    checks.push(name);
  }
  function rejects(name, fn){
    let failed = false;
    try { fn(); } catch(_){ failed = true; }
    check(name, failed);
  }
  const sub = "00000000-0000-0000-0000-000000000001";
  const token = "fixture-token-never-send-to-azure";
  const metric = (key="cores",currentValue=8,limit=10) => ({name:{value:key,localizedValue:key},currentValue,limit,unit:"Count"});
  const account = rg => ({id:`/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Automation/automationAccounts/shared`,name:"shared",location:"eastus"});
  const originalFetch = window.fetch;
  const original = {rows,platformRows,failures,quotaRequests,subNames,RUN,authHalt,inventory,inventoryFetched,inventoryError,zoneMaps,zoneMapFetched,wasteSignals,
    isSample,prevSnapshot,regions:[...selectedRegions],prefs:localStorage.getItem(PREFS_KEY)};
  const controls = [...document.querySelectorAll("input,select,textarea")].map(el => [el,el.value,el.checked]);
  const response = (data,status=200) => new Response(typeof data === "string" ? data : JSON.stringify(data),{status,headers:{"Content-Type":"application/json"}});
  const calls = [];
  let frame;
  try{
    window.fetch = async (url,options={}) => {
      calls.push({url:String(url),method:options.method || "GET"});
      if(String(url).includes("automationAccounts?")) return response({value:[account("rg-one"),account("rg-two")]});
      if(String(url).includes("/automationAccounts/")) return response({value:[metric("subscriptionUsage",1,100),metric("jobs",2,5)]});
      if(String(url).includes("checkQuotaAvailability")) return response({hostsRemaining:{AV36:3,AV20:0},quotaEnabled:"Enabled"});
      if(String(url).includes("/usages")) return response({value:[metric()]});
      if(/^https:\/\/management.azure.com\/subscriptions\/[^/?]+\?/.test(String(url))) return response({displayName:"Fixture subscription"});
      throw new Error("Unmocked URL: "+url);
    };
    for(const [provider,cfg] of Object.entries(SERVICE_QUOTAS)){
      const task = {kind:provider==="appservice"?"usage":"service",provider,sub,region:provider==="automation"?"all":"eastus",regions:["eastus"]};
      const result = await runTask(task,token);
      check(provider+" dispatch succeeds",result.ok && result.rows.length>0);
      check(provider+" retains identity",result.rows.every(r => r.provider === provider));
      if(provider!=="automation"){
        const call = calls.at(-1);
        check(provider+" exact URL and HTTP method",call.url===serviceQuotaUrl(provider,sub,"eastus") && call.method===(cfg.method || "GET"));
      }else{
        check("Automation scope and subscription deduplication",result.rows.length===3 && result.rows.filter(r=>r.scope==="Subscription").length===1);
        const scoped = result.rows.filter(r=>r.key==="jobs");
        check("Automation account identities do not collide",diffKey(scoped[0])!==diffKey(scoped[1]));
        check("Automation subscription scope is global",result.rows.find(r=>r.scope==="Subscription").region==="all");
      }
    }
    const independent=makePlatformRun(2);
    for(const provider of ["web","sql","postgres","storage"]){
      check("Independent Platform collector "+provider,(await platformRegionalTask(independent,{sub,region:"eastus",provider},token)).ok);
    }
    check("Independent Platform Automation account scope",(await platformAutomationTask(independent,{sub,region:"eastus",account:account("rg-one")},token)).rows.some(r=>r.resourceId===account("rg-one").id));
    const avs = normalizeAvsQuota({hostsRemaining:{AV36:0},quotaEnabled:"Disabled"},sub,"eastus")[0];
    check("AVS is remaining-only, including explicit zero",avs.remaining===0 && avs.current===null && avs.limit===null && avs.pct===null && quotaRemaining(avs)===0);
    rejects("AVS malformed payload rejected",()=>normalizeAvsQuota({hostsRemaining:{AV36:-1},quotaEnabled:"Enabled"},sub,"eastus"));
    rejects("AVS unknown enabled state rejected",()=>normalizeAvsQuota({hostsRemaining:{AV36:1}},sub,"eastus"));
    const zero = normalizeServiceUsages([metric("zero",0,0)],"aci","eastus",sub)[0];
    const unlimited = normalizeServiceUsages([metric("unlimited",2,-1)],"aci","eastus",sub)[0];
    const unknown = normalizeServiceUsages([{...metric("unknown"),limit:null}],"aci","eastus",sub)[0];
    check("Zero, unknown and unlimited have distinct semantics",hasKnownLimit(zero) && !hasKnownLimit(unknown) && unlimited.unlimited && zero.pct===null && unknown.pct===null);
    check("Percentages can exceed 100",normalizeServiceUsages([metric("over",12,10)],"aci","eastus",sub)[0].pct===120);
    for(const bad of [{...metric(),currentValue:null},{...metric(),currentValue:""},{...metric(),currentValue:-1},{...metric(),unit:null},{...metric(),name:null},{...metric(),limit:"bad"},{...metric(),limit:-0.5}]){
      rejects("Invalid quota field rejected "+checks.length,()=>normalizeServiceUsages([bad],"aci","eastus",sub));
    }
    check("Platform SQL normalization remains available",normalizePlatformUsages([metric()],{provider:"sql",sub,region:"eastus"})[0].provider==="sql");
    const devops = {...metric("standardDFamily"),id:`/subscriptions/${sub}/providers/Microsoft.Compute/locations/eastus/providers/Microsoft.DevOpsInfrastructure/Usages/standardDFamily`};
    check("DevOps Compute-looking IDs preserve service",rowsFromImportArrays([[devops]],"eastus",sub)[0].provider==="devopspools");
    check("Scoped native records import before unified quota heuristics",rowsFromImportArrays([[{properties:metric(),sourceProvider:"postgres",location:"eastus",subscriptionId:sub}]],"", "")[0].provider==="postgres");
    rejects("Unsupported explicit source rejected",()=>rowsFromImportArrays([[{...metric(),sourceProvider:"fabric"}]],"eastus",sub));
    rejects("Unknown native namespace rejected",()=>rowsFromImportArrays([[{...metric(),id:"/providers/Microsoft.Fabric/usages/a"}]],"eastus",sub));
    const imported = rowsFromImportArrays([[{...metric("jobs"),sourceProvider:"automation",subscriptionId:sub,location:"eastus",sourceScope:"rg-one / shared",sourceResourceId:account("rg-one").id},
      {hostsRemaining:{AV36:0},quotaEnabled:"Enabled",sourceProvider:"avs",subscriptionId:sub,location:"eastus"}]],"","");
    check("Offline scope and remaining-only import",imported[0].resourceId===account("rg-one").id && imported[1].current===null && imported[1].remaining===0);
    const url = serviceQuotaUrl("aci",sub,"eastus");
    for(const [name,data] of [
      ["malformed collection",{value:{}}],
      ["malformed nextLink",{value:[metric()],nextLink:42}],
      ["cross-origin continuation",{value:[metric()],nextLink:"https://example.invalid/steal"}],
      ["cross-endpoint continuation",{value:[metric()],nextLink:url.replace("eastus","westus")}],
      ["cyclic continuation",{value:[metric()],nextLink:url}],
      ["invalid JSON","not-json"]
    ]){
      let n=0;
      window.fetch = async () => {n++;return response(data);};
      const result = await fetchAllPages(url,token,true);
      check(name+" fails closed",!result.ok && result.status===200 && n===1);
    }
    let pageCount=0;
    window.fetch = async () => {pageCount++;return pageCount===1?response({value:[metric()],nextLink:url+"&page=2"}):response({error:{code:"Forbidden",message:"fixture"}},403);};
    check("Partial pagination is not success",!(await fetchAllPages(url,token,true)).ok);
    window.fetch=async url=>response({value:[{properties:url.includes("/quotas?")?{name:{value:"standardDFamily"},limit:{value:10},unit:"Count"}:{name:{value:"standardDFamily"},usages:{value:8}}}]});
    const unified=await fetchQuota(sub,"Microsoft.MachineLearningServices","eastus",token);
    check("Unified quotas join actual usage and retain namespace",unified.ok && unified.rows[0].current===8 && !isComputeQuota(unified.rows[0]));
    window.fetch=async url=>response({value:url.includes("/quotas?")?[{properties:{name:{value:"cores"},limit:{value:10},unit:"Count"}}]:[]});
    check("Missing unified usage cannot become zero",!(await fetchQuota(sub,"Microsoft.Compute","eastus",token)).ok);
    rejects("Quota-only JSON cannot invent usage",()=>rowsFromImportArrays([[{properties:{name:{value:"cores"},limit:{value:10}}}]],"eastus",sub));
    pageCount=0;
    window.fetch = async () => {pageCount++;return response({value:[metric()],nextLink:url+"&page="+pageCount});};
    const capped = await fetchAllPages(url,token,true);
    check("50-page cap fails explicitly",!capped.ok && pageCount===50);
    window.fetch = async () => response({error:{code:"AuthorizationFailed",message:"fixture"}},403);
    check("Pending-request failures remain visible",!(await fetchQuotaRequests(sub,"Microsoft.Compute","eastus",token)).ok);
    check("AVS permission denial is explicit",!(await runTask({kind:"service",provider:"avs",sub,region:"eastus"},token)).ok);
    window.fetch = async () => response({error:{code:"ExpiredAuthenticationToken",message:"fixture"}},401);
    check("401 survives service dispatch for resumable execution",(await runTask({kind:"service",provider:"aci",sub,region:"eastus"},token)).status===401);
    let throttled = 0;
    const methods = [];
    window.fetch = async (url,options) => {
      methods.push(options.method);
      if(throttled++===0) return new Response('{"error":{"code":"TooManyRequests"}}',{status:429,headers:{"Retry-After":"0.001"}});
      return response({hostsRemaining:{AV36:3},quotaEnabled:"Enabled"});
    };
    check("AVS throttling retries preserve read-only POST",(await runTask({kind:"service",provider:"avs",sub,region:"eastus"},token)).ok && methods.length===2 && methods.every(method=>method==="POST"));
    window.fetch = async () => response({value:[]});
    check("Empty service collection is unknown, not zero",!(await runTask({kind:"service",provider:"aci",sub,region:"eastus"},token)).ok);
    check("Unknown usage provider cannot become Compute",!(await runTask({kind:"usage",provider:"fabric",sub,region:"eastus"},token)).ok);
    calls.length=0;
    window.fetch = async (url,options={}) => {
      calls.push({url:String(url),method:options.method || "GET"});
      if(String(url).includes("/usages")) return response({value:[metric()]});
      if(String(url).includes("checkQuotaAvailability")) return response({hostsRemaining:{AV36:0},quotaEnabled:"Enabled"});
      if(/^https:\/\/management.azure.com\/subscriptions\/[^/?]+\?/.test(String(url))) return response({displayName:"Fixture"});
      throw new Error("Unexpected service-only request "+url);
    };
    document.querySelectorAll(".provChk").forEach(c=>c.checked=c.value==="quota");
    document.querySelectorAll(".quotaRpChk").forEach(c=>c.checked=["Microsoft.ContainerInstance","Microsoft.AVS"].includes(c.value));
    $("subId").value=sub; $("token").value=token;
    selectedRegions.clear(); selectedRegions.add("eastus");
    await runLive();
    check("Service-only run completes without failures",rows.length===2 && failures.length===0 && RUN===null);
    check("Service-only run never silently enables inventory",!document.querySelector('.provChk[value="inventory"]').checked && !calls.some(c=>/ResourceGraph|Microsoft.Compute|quotaRequests|\/subscriptions\/[^/]+\/locations/.test(c.url)));
    let expired = true;
    calls.length=0;
    window.fetch = async (url,options={})=>{
      calls.push({url:String(url),method:options.method || "GET"});
      if(String(url).includes("Microsoft.ContainerInstance")) return expired ? response({error:{code:"ExpiredAuthenticationToken",message:"fixture"}},401) : response({value:[metric()]});
      if(String(url).includes("checkQuotaAvailability")) return response({hostsRemaining:{AV36:0},quotaEnabled:"Enabled"});
      if(/^https:\/\/management.azure.com\/subscriptions\/[^/?]+\?/.test(String(url))) return response({displayName:"Fixture"});
      throw new Error("Unexpected resume request "+url);
    };
    await runLive();
    check("Expired service run pauses resumably",RUN!==null && authHalt && RUN.doneIdx.size<RUN.total);
    expired=false;
    await resumeRun();
    check("Resume retries unfinished descriptors without duplicating results",RUN===null && rows.length===2 && calls.filter(c=>c.url.includes("Microsoft.ContainerInstance")).length===2 && calls.filter(c=>c.url.includes("checkQuotaAvailability")).length===1);
    check("Service-only resume does not add VM post-processing",!calls.some(c=>/ResourceGraph|Microsoft.Compute|\/subscriptions\/[^/]+\/locations/.test(c.url)));
    rows = [...imported,zero,unlimited,unknown,avs,normalizeServiceUsages([metric("over",12,10)],"search","taiwannorth",sub)[0]];
    platformRows=[]; failures=[{provider:"aci",sub,region:"eastus",status:403,error:"Fixture failure <not markup>"}];
    quotaRequests=[]; prevSnapshot=null; isSample=false;
    $("thresh").value=0;
    $("fProvider").value=""; $("fRegion").value=""; $("fLabel").value="";
    $("fCurrent").value=""; $("fLimit").value=""; $("fRemaining").value=""; $("fPct").value="";
    $("hideZero").checked=false; $("hideZeroPct").checked=false;
    $("exportNonzero").checked=true;
    render();
    check("Main remaining-only renderer shows unknown usage",rowHtml(avs).includes('col-current">\u2014') && rowHtml(avs).includes(">0") && rowHtml(avs).includes("n/a"));
    check("Unlimited has explicit label",rowHtml(unlimited).includes("Unlimited"));
    check("Scoped resource label remains visible",rowHtml(imported[0]).includes("rg-one / shared"));
    platformRows=normalizePlatformUsages([metric()],{sub,provider:"sql",region:"taiwannorth",scope:"Subscription"});
    check("Independent Platform HTML preserves version, provider and Preview region",buildPlatformReportHtml().includes(`Version ${APP_VERSION}`) && buildPlatformReportHtml().includes("Azure SQL") && buildPlatformReportHtml().includes("taiwannorth (Preview)"));
    check("Remaining-only values survive view recomputation",currentView().some(r=>r.kind==="remaining-only" && r.remaining===0));
    $("hideZero").checked=true; $("hideZeroPct").checked=true;
    check("Remaining-only values survive zero filters",currentView().some(r=>r.kind==="remaining-only"));
    const snapshot = buildSnapshotFromText(JSON.stringify(rows),"fixture.json");
    check("Snapshot retains scope identity, remaining capacity and unknown values",Object.keys(snapshot).includes(diffKey(imported[0])) && snapshot[diffKey(avs)].current===null && snapshot[diffKey(avs)].remaining===0);
    prevSnapshot={[diffKey(avs)]:{current:null,limit:null,remaining:5}};
    check("Remaining-only snapshot comparison shows remaining delta",rowHtml(avs).includes("was 5"));
    prevSnapshot=null;
    const scopedCsv = "Provider,Region,Key,Used,Limit,Scope,ResourceId,ResourceProvider,SubscriptionId\n"+
      `automation,eastus,jobs,8,10,rg-one / shared,${account("rg-one").id},Microsoft.Automation,${sub}`;
    check("CSV comparison retains subscription and resource ID",Object.keys(buildSnapshotFromText(scopedCsv,"fixture.csv"))[0]===diffKey(imported[0]));
    let csvBlob;
    const createUrl=URL.createObjectURL,clickAnchor=HTMLAnchorElement.prototype.click;
    try {
      URL.createObjectURL=blob=>{csvBlob=blob;return "blob:fixture";};
      HTMLAnchorElement.prototype.click=function(){};
      $("csvBtn").click();
    }finally{URL.createObjectURL=createUrl;HTMLAnchorElement.prototype.click=clickAnchor;}
    const csv=(await csvBlob.text()).split("\n").map(splitCsv);
    const csvHead=csv[0],csvAvs=csv.find(c=>c[0]==="avs");
    check("CSV remaining-only columns are empty, not invented zeros",csvAvs[csvHead.indexOf("Used")]==="" && csvAvs[csvHead.indexOf("Limit")]==="" && csvAvs[csvHead.indexOf("Remaining")]==="0" && csvAvs[csvHead.indexOf("PercentUsed")]==="");
    check("CSV includes scope and canonical subscription identity",csvHead.includes("ResourceId") && csvAvs[csvHead.indexOf("SubscriptionId")]===sub);
    const html = await buildReportHtml();
    check("Report version, Preview regions and failure disclosure",html.includes(`Version ${APP_VERSION}`) && html.includes("coverage is incomplete") && html.includes("Fixture failure &lt;not markup&gt;") && html.includes('southeastasia3') && html.includes("taiwannorth"));
    check("Export does not contain bearer token",!html.includes(token));
    frame=document.createElement("iframe"); document.body.appendChild(frame);
    frame.srcdoc=html;
    await new Promise((resolve,reject)=>{
      const stop=Date.now()+10000;
      const wait=()=>frame.contentDocument?.querySelector("tr[data-grp1]")?resolve():Date.now()>stop?reject(new Error("Report runtime did not render")):setTimeout(wait,20);
      wait();
    });
    frame.contentDocument.querySelectorAll("tr[data-grp1]").forEach(el=>el.click());
    frame.contentDocument.querySelectorAll("tr[data-grp2]").forEach(el=>el.click());
    const reportText=frame.contentDocument.body.textContent;
    check("Standalone runtime preserves AVS and scopes",reportText.includes("AV36 hosts") && reportText.includes("rg-one / shared"));
    check("Standalone provider names and Preview labels",reportText.includes("Search") && reportText.includes("taiwannorth (Preview)"));
    check("Standalone unlimited limit is explicit",reportText.includes("Unlimited"));
    check("Standalone remaining-only value is not invented zero usage",[...frame.contentDocument.querySelectorAll("tbody tr")].some(el=>el.textContent.includes("AV36 hosts") && [...el.querySelectorAll("td")].some(td=>td.textContent==="\u2014")));
    frame.remove(); frame=null;
    rows=[avs]; inventory=[]; inventoryFetched=false; failures=[]; wasteSignals={stoppedAllocatedVms:0,unattachedDisks:0,idlePublicIPs:0};
    frame=document.createElement("iframe"); document.body.appendChild(frame);
    frame.srcdoc=await buildReportHtml();
    await new Promise((resolve,reject)=>{
      const stop=Date.now()+10000;
      const wait=()=>frame.contentDocument?.querySelector("tr[data-grp1]")?resolve():Date.now()>stop?reject(new Error("AVS-only report did not render")):setTimeout(wait,20);
      wait();
    });
    check("AVS-only report is not given a fabricated health grade",frame.contentDocument.body.textContent.includes("Usage health is unavailable") && !frame.contentDocument.querySelector(".healthband .grade"));
    document.querySelectorAll(".scriptProv").forEach(c=>c.checked=["avs","aci"].includes(c.value));
    savePrefs();
    check("Saved preferences never contain token",!localStorage.getItem(PREFS_KEY).includes(token));
    document.querySelectorAll(".quotaRpChk,.scriptProv").forEach(c=>c.checked=false);
    restorePrefs();
    check("Scope and collector preferences restore",document.querySelector('.quotaRpChk[value="Microsoft.AVS"]').checked && document.querySelector('.scriptProv[value="avs"]').checked && !$("avsPermissionNote").hidden);
    const providers=["compute","network","quota",...Object.keys(SERVICE_QUOTAS)];
    const scripts=serviceCollectorScripts([sub],["eastus","taiwannorth"],providers,3,true);
    const scriptsAll=serviceCollectorScripts([sub],[],providers,3,true);
    return {checks,scripts,scriptsAll,sub};
  }finally{
    if(frame) frame.remove();
    window.fetch=originalFetch;
    ({rows,platformRows,failures,quotaRequests,subNames,RUN,authHalt,inventory,inventoryFetched,inventoryError,zoneMaps,zoneMapFetched,wasteSignals,isSample,prevSnapshot}=original);
    selectedRegions.clear(); original.regions.forEach(r=>selectedRegions.add(r));
    controls.forEach(([el,value,checked])=>{el.value=value;el.checked=checked;});
    if(original.prefs==null) localStorage.removeItem(PREFS_KEY); else localStorage.setItem(PREFS_KEY,original.prefs);
    updateAvsNotice(); updateScripts();
  }
}
