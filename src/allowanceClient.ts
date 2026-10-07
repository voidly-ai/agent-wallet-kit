import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { checkedSpendAllowanceGrant, canonicalSpendAllowanceGrant, spendAllowanceBodyHash,
  spendAllowanceSigningMessage, type SpendAllowanceAction, type SpendAllowanceGrant } from './spendAllowance.js';

/** The host must obtain approval before grant/revoke. This client does not infer human consent. */
export async function requestSpendAllowance(grantInput: SpendAllowanceGrant,
  action: SpendAllowanceAction, body: unknown,
  signMessage: (input: {message:string})=>Promise<`0x${string}`>, fetcher:typeof fetch=fetch):Promise<Record<string,unknown>> {
  const grant=checkedSpendAllowanceGrant(grantInput);
  const now=Math.floor(Date.now()/1000);const expiresAt=now+60;
  const nonce=`0x${Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('')}` as const;
  const message=spendAllowanceSigningMessage({action,network:grant.network,origin:grant.origin,
    grantId:grant.grantId,bodyHash:await spendAllowanceBodyHash(body),nonce,expiresAt},now);
  const signature=await signMessage({message});
  if(!/^0x[0-9a-fA-F]{130}$/.test(signature))throw new Error('Allowance proof signer returned invalid bytes');
  const path=action==='grant'?'grant':`${grant.grantId}/${action}`;
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),15000);
  const bounded = async <T>(promise:Promise<T>):Promise<T> => {
    let rejectAbort:()=>void=()=>{};
    const abort=new Promise<never>((_,reject)=>{rejectAbort=()=>reject(new Error('Allowance response deadline exceeded'));
      controller.signal.addEventListener('abort',rejectAbort,{once:true});
      if(controller.signal.aborted)rejectAbort();});
    try{return await Promise.race([promise,abort]);}finally{controller.signal.removeEventListener('abort',rejectAbort);}
  };
  try {
    const response=await bounded(fetcher(`${grant.origin}/v1/spend-allowances/${path}`,{
      method:'POST',redirect:'manual',signal:controller.signal,headers:{'content-type':'application/json'},
      body:JSON.stringify({body,proof:{nonce,expiresAt,signature:signature.toLowerCase()}}),
    }));
    if(!response.ok || response.headers.get('content-type')?.split(';')[0]?.trim()!=='application/json')
      throw new Error('Allowance operation unavailable; reconcile the same grant and quote, never retry a purchase automatically');
    const reader=response.body?.getReader();if(!reader)throw new Error('Allowance response missing');
    let length=0;const chunks:Uint8Array[]=[];
    try {while(true){
      const next=await bounded(reader.read());if(next.done)break;
      length+=next.value.length;if(length>32768){await reader.cancel();throw new Error('Allowance response exceeds limit');}
      chunks.push(next.value);
    }}finally{reader.releaseLock();}
    const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid allowance response');
    return value as Record<string,unknown>;
  } finally {clearTimeout(timer);}
}

/** Append-only local approval markers; a revoke tombstone never re-enables the same ID. */
export class FileSpendAllowanceStore {
  constructor(private readonly directory:string){}
  private async root():Promise<void>{
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const stat=await lstat(this.directory);
    if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0 ||
      typeof process.getuid==='function'&&stat.uid!==process.getuid())throw new Error('Unsafe allowance state directory');
  }
  private path(id:string,wallet:string,network:string,suffix:string):string {
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)||
      !/^0x[0-9a-f]{40}$/.test(wallet)||!['eip155:8453','eip155:84532'].includes(network))throw new Error('Invalid allowance state identity');
    return join(this.directory,`allowance-${network.slice(7)}-${wallet}-${id}.${suffix}.json`);
  }
  private async read(path:string):Promise<string|null>{
    let file;try{file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(error){
      if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
    try{const stat=await file.stat();if(!stat.isFile()||stat.size>32768||(stat.mode&0o077)!==0||
      typeof process.getuid==='function'&&stat.uid!==process.getuid())throw new Error('Unsafe allowance state file');
      return await file.readFile('utf8');}finally{await file.close();}
  }
  private async append(path:string,value:string):Promise<void>{
    const existing=await this.read(path);if(existing!==null){if(existing!==value)throw new Error('Allowance state conflict');return;}
    const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{await file.writeFile(value);await file.sync();}finally{await file.close();}
    const directory=await open(this.directory,constants.O_RDONLY);try{await directory.sync();}finally{await directory.close();}
  }
  async prepare(input:SpendAllowanceGrant):Promise<void>{
    const grant=checkedSpendAllowanceGrant(input);await this.root();
    await this.append(this.path(grant.grantId,grant.payer,grant.network,'prepared'),canonicalSpendAllowanceGrant(grant));
  }
  async enable(input:SpendAllowanceGrant):Promise<void>{
    const grant=checkedSpendAllowanceGrant(input);await this.root();
    if(await this.read(this.path(grant.grantId,grant.payer,grant.network,'revoked'))!==null)throw new Error('Allowance was locally revoked');
    await this.append(this.path(grant.grantId,grant.payer,grant.network,'approved'),canonicalSpendAllowanceGrant(grant));
  }
  async get(id:string,wallet:string,network:string,includeDisabled=false):Promise<SpendAllowanceGrant|null>{
    await this.root();let raw=await this.read(this.path(id,wallet,network,'approved'));
    if(raw===null&&includeDisabled)raw=await this.read(this.path(id,wallet,network,'prepared'));
    if(raw===null)return null;
    const grant=checkedSpendAllowanceGrant(JSON.parse(raw));
    if(grant.grantId!==id||grant.payer!==wallet||grant.network!==network)throw new Error('Allowance state identity mismatch');
    if(!includeDisabled&&await this.read(this.path(id,wallet,network,'revoked'))!==null)return null;
    return grant;
  }
  async disable(grant:SpendAllowanceGrant):Promise<void>{
    await this.root();await this.append(this.path(grant.grantId,grant.payer,grant.network,'revoked'),'true');
  }
}
