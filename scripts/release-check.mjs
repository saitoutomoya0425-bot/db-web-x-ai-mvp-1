import { spawnSync } from "node:child_process";
const npm=process.platform==="win32"?"npm.cmd":"npm";
const steps=[
  ["Environment","run","preflight:production"],
  ["Supabase","run","check:supabase"],
  ["Migrations","run","db:migrate:check"],
  ["AI tests","run","test:ai"],
  ["Lint","run","lint"],
  ["Build","run","build"],
];
const results=[];
for(const [label,...args] of steps){
  console.log(`\n=== ${label} ===`);
  const result=spawnSync(npm,args,{stdio:"inherit",env:process.env});
  results.push({label,ok:result.status===0,status:result.status});
}
console.log("\n=== Release summary ===");
for(const result of results)console.log(`${result.ok?"PASS":"FAIL"} ${result.label}`);
if(results.some(result=>!result.ok))process.exitCode=1;
