const url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY,anon=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const missing=[!url&&"NEXT_PUBLIC_SUPABASE_URL",!anon&&"NEXT_PUBLIC_SUPABASE_ANON_KEY",!key&&"SUPABASE_SERVICE_ROLE_KEY"].filter(Boolean);
if(missing.length)throw new Error(`Missing: ${missing.join(", ")}`);
const headers={apikey:key,authorization:`Bearer ${key}`};
let insertedId=null,deleteStatus=null;
try{
  const [auth,read]=await Promise.all([
    fetch(`${url}/auth/v1/admin/users?page=1&per_page=1`,{headers}),
    fetch(`${url}/rest/v1/videos?select=id&limit=1`,{headers:{...headers,prefer:"count=estimated"}}),
  ]);
  const marker=`connection-check-${crypto.randomUUID()}`;
  const write=await fetch(`${url}/rest/v1/search_logs`,{method:"POST",headers:{...headers,"content-type":"application/json",prefer:"return=representation"},body:JSON.stringify({product_code:marker,source:"connection_check"})});
  const rows=write.ok?await write.json():[];insertedId=rows?.[0]?.id??null;
  if(insertedId){const remove=await fetch(`${url}/rest/v1/search_logs?id=eq.${encodeURIComponent(insertedId)}`,{method:"DELETE",headers});deleteStatus=remove.status;}
  const result={environment:"ok",auth:auth.status,read:read.status,count:read.headers.get("content-range"),write:write.status,cleanup:deleteStatus};
  console.log(JSON.stringify(result,null,2));
  if(auth.status!==200||!read.ok||write.status!==201||deleteStatus!==204)process.exitCode=1;
}finally{
  if(insertedId&&deleteStatus!==204)await fetch(`${url}/rest/v1/search_logs?id=eq.${encodeURIComponent(insertedId)}`,{method:"DELETE",headers}).catch(()=>undefined);
}
