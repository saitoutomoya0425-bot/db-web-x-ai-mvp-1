import { spawnSync } from "node:child_process";
const npm=process.platform==="win32"?"npm.cmd":"npm";
for(const args of [["run","db:migrate"],["run","seed:admin"],["run","check:supabase"]]){
  const result=spawnSync(npm,args,{stdio:"inherit",env:process.env});
  if(result.status!==0)process.exit(result.status??1);
}
console.log("Production database bootstrap completed.");
