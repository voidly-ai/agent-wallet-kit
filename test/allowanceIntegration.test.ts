import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http';
import { AgentWallet, FileSpendAllowanceStore, MemoryMarketplaceAttemptStore, MemorySpendStore,
  PaymentMayHaveSettledError, type SpendAllowanceGrant } from '../src/index.js';

const payer='0x1111111111111111111111111111111111111111';
const payTo='0x2222222222222222222222222222222222222222';
const quoteId=`0x${'a'.repeat(64)}`;
function grant():SpendAllowanceGrant {const now=Math.floor(Date.now()/1000);return {
  version:'voidpay-spend-allowance/v1',grantId:'00000000-0000-4000-8000-000000000001',
  origin:'https://x402-staging.voidly.ai',network:'eip155:84532',asset:'0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  owner:payer,payer,dailyLimitAtomic:'30000',perCallLimitAtomic:'20000',validAfter:now-10,expiresAt:now+3600,
  listings:[{listingId:'echo1234',version:1,payTo}],
};}
type ExternalSigner=Parameters<typeof AgentWallet.fromSigner>[0]&{
  signMessage(input:{message:string}):Promise<`0x${string}`>;
};
function fixture(change?:(value:Record<string,unknown>)=>Record<string,unknown>,timeout=60,
  signerFactory?:(events:string[])=>ExternalSigner) {
  const approved=grant();const attempts=new MemoryMarketplaceAttemptStore();const events:string[]=[];
  const payments:ReturnType<typeof decodePaymentSignatureHeader>[]=[];
  const body={prompt:'echo'};const resourceUrl=`${approved.origin}/v1/services/echo1234/call?quote=${quoteId}`;
  const digest=`0x${createHash('sha256').update(JSON.stringify(body)).digest('hex')}`;
  const signer=signerFactory?signerFactory(events):{address:payer as `0x${string}`,async signMessage(){events.push('proof');return `0x${'11'.repeat(65)}` as `0x${string}`;},
    async signTypedData(){events.push('payment-sign');return `0x${'11'.repeat(64)}1b` as `0x${string}`;}};
  const fetcher:typeof fetch=async(input,init)=>{
    const request=new Request(input,init);
    if(request.url.endsWith('/reserve')){
      events.push('reserve');const envelope=await request.json() as any;
      assert.deepEqual(envelope.body,{quoteId});assert.match(envelope.proof.nonce,/^0x[0-9a-f]{64}$/);
      const now=Date.now();const day=new Date(now).toISOString().slice(0,10);const quoteExpiresAt=now+120000;
      const value={quoteId,resourceUrl,listingId:'echo1234',listingVersion:1,payTo,payer,
        network:approved.network,asset:approved.asset,amountAtomic:'10000',inputSha256:digest,
        quoteExpiresAt,grantId:approved.grantId,day,reservedUntil:Math.min(quoteExpiresAt,
          approved.expiresAt*1000,Date.parse(`${day}T00:00:00Z`)+86400000),paymentKey:null};
      return Response.json({reservation:change?change(value):value,automaticRetry:false});
    }
    assert.equal(request.headers.get('x-voidpay-spend-allowance'),approved.grantId);
    if(request.headers.has('payment-signature')){
      events.push('paid');assert.equal((await attempts.list(payer,approved.network))[0]?.quoteId,quoteId);
      payments.push(decodePaymentSignatureHeader(request.headers.get('payment-signature')!));
      throw new Error('synthetic lost paid response');
    }
    events.push('challenge');return new Response('{}',{status:402,headers:{'payment-required':encodePaymentRequiredHeader({
      x402Version:2,resource:{url:resourceUrl},accepts:[{scheme:'exact',network:approved.network,asset:approved.asset,
        amount:'10000',payTo,maxTimeoutSeconds:timeout,extra:{name:'USDC',version:'2',assetTransferMethod:'eip3009',paymentFlow:'upfront'}}],
      extensions:{'voidpay.intent':{info:{version:1,listingId:'echo1234',listingVersion:1,quoteId,resource:resourceUrl,
        inputDigest:digest,sellerWallet:payTo,amountAtomic:'10000'},schema:{}}},
    })}});
  };
  const wallet=AgentWallet.fromSigner(signer,{network:'base-sepolia',limits:{perCallUsd:'0.02',dailyUsd:'0.03'},
    spendStore:new MemorySpendStore(),marketplaceAttemptStore:attempts,unsafeAllowVolatileSpendStoreForTests:true,fetcher});
  const buy=()=>wallet.payX402({url:`${approved.origin}/v1/services/echo1234/call`,method:'POST',body,
    expectedMarketplace:{listingId:'echo1234',version:1,payTo},spendAllowance:approved});
  return {events,attempts,payments,buy};
}
test('allowance reserves before signing, persists original attempt, sends one payment and retains uncertainty',async()=>{
  const f=fixture();await assert.rejects(f.buy(),error=>error instanceof PaymentMayHaveSettledError&&error.quoteId===quoteId);
  assert.deepEqual(f.events,['challenge','proof','reserve','payment-sign','paid']);
  assert.equal((await f.attempts.list(payer,'eip155:84532')).length,1);
});
test('allowance preserves a class signer prototype address and original method receiver',async()=>{
  class PrototypeSigner implements ExternalSigner {
    #address=payer as `0x${string}`;
    #events:string[];
    constructor(events:string[]){this.#events=events;}
    get address(){return this.#address;}
    async signMessage({message}:{message:string}){
      assert.ok(message.length>0);
      this.#events.push('proof');
      return `0x${'11'.repeat(65)}` as `0x${string}`;
    }
    async signTypedData(parameters:Parameters<ExternalSigner['signTypedData']>[0]){
      assert.equal((parameters.message as Record<string,unknown>).from,this.#address);
      this.#events.push('payment-sign');
      return `0x${'11'.repeat(64)}1b` as `0x${string}`;
    }
  }
  const f=fixture(undefined,60,events=>new PrototypeSigner(events));
  await assert.rejects(f.buy(),error=>error instanceof PaymentMayHaveSettledError&&error.quoteId===quoteId);
  assert.deepEqual(f.events,['challenge','proof','reserve','payment-sign','paid']);
  assert.equal(f.payments.length,1);
  const authorization=f.payments[0]!.payload.authorization as Record<string,unknown>;
  assert.equal(authorization.from,payer);
  assert.equal(authorization.to,payTo);
  assert.equal(authorization.value,'10000');
  const attempts=await f.attempts.list(payer,'eip155:84532');
  assert.equal(attempts.length,1);
  assert.equal(attempts[0]!.wallet,payer);
  assert.equal(attempts[0]!.quoteId,quoteId);
});
test('unsupported gateway challenge and malformed reservation cause no payment signature or paid retry',async()=>{
  for(const change of [
    (v:Record<string,unknown>)=>({...v,payer:payTo}),
    (v:Record<string,unknown>)=>({...v,amountAtomic:'10001'}),
    (v:Record<string,unknown>)=>({...v,paymentKey:`0x${'b'.repeat(64)}`}),
    (v:Record<string,unknown>)=>({...v,reservedUntil:Date.now()-1}),
  ]){const f=fixture(change);await assert.rejects(f.buy());assert.ok(!f.events.includes('payment-sign'));assert.ok(!f.events.includes('paid'));}
  const unavailable=fixture(undefined,120);await assert.rejects(unavailable.buy());
  assert.deepEqual(unavailable.events,['challenge']);
});
test('local approval survives restart and a revoke tombstone prevents re-enabling the same grant',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'voidly-allowance-source-test-'));
  const approved=grant();const store=new FileSpendAllowanceStore(directory);
  assert.equal(await store.get(approved.grantId,payer,approved.network),null);
  await store.enable(approved);
  const restored=new FileSpendAllowanceStore(directory);
  assert.deepEqual(await restored.get(approved.grantId,payer,approved.network),approved);
  await restored.disable(approved);
  assert.equal(await store.get(approved.grantId,payer,approved.network),null);
  assert.deepEqual(await store.get(approved.grantId,payer,approved.network,true),approved);
  await assert.rejects(store.enable(approved),/revoked/);
  // Fixtures are retained per owner storage/evidence instructions.
});
test('local approval refuses a symlink state directory',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'voidly-allowance-link-test-'));
  const link=`${directory}-link`;await symlink(directory,link);
  await assert.rejects(new FileSpendAllowanceStore(link).enable(grant()),/Unsafe/);
});


test('pending owner grant survives an uncertain registration without enabling purchases',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'voidly-allowance-pending-test-'));
  const approved=grant();const store=new FileSpendAllowanceStore(directory);
  await store.prepare(approved);
  const restored=new FileSpendAllowanceStore(directory);
  assert.equal(await restored.get(approved.grantId,payer,approved.network),null);
  assert.deepEqual(await restored.get(approved.grantId,payer,approved.network,true),approved);
  await restored.disable(approved);
  await assert.rejects(restored.enable(approved),/revoked/);
});

function markerPath(directory:string,approved:SpendAllowanceGrant,suffix:string):string {
  return join(directory,`allowance-${approved.network.slice(7)}-${approved.payer}-${approved.grantId}.${suffix}.json`);
}
test('partial approval preserves prepared status and revoke recovery while purchases remain disabled',async()=>{
  for(const partial of ['', '{"version":"voidpay-spend-allowance/v1"']){
    const directory=await mkdtemp(join(tmpdir(),'voidly-allowance-partial-test-'));
    const approved=grant();const store=new FileSpendAllowanceStore(directory);
    await store.prepare(approved);
    const approvedPath=markerPath(directory,approved,'approved');
    await writeFile(approvedPath,partial,{flag:'wx',mode:0o600});
    assert.equal((await stat(approvedPath)).mode&0o777,0o600);
    const restored=new FileSpendAllowanceStore(directory);
    const recovered=await restored.get(approved.grantId,payer,approved.network,true);
    assert.deepEqual(recovered,approved);
    await assert.rejects(restored.get(approved.grantId,payer,approved.network));
    await restored.disable(recovered!);
    const revoked=new FileSpendAllowanceStore(directory);
    assert.deepEqual(await revoked.get(approved.grantId,payer,approved.network,true),approved);
    await assert.rejects(revoked.enable(approved),/revoked/);
    // Even completing the interrupted approval cannot bypass the durable tombstone.
    await writeFile(approvedPath,JSON.stringify(approved));
    assert.equal(await revoked.get(approved.grantId,payer,approved.network),null);
    // Fixtures are retained per owner storage/evidence instructions.
  }
});
test('status and revoke reject malformed or mismatched prepared markers instead of falling back to approval',async()=>{
  const approved=grant();
  for(const invalid of ['', '{"version":', '{}',
    JSON.stringify({...approved,grantId:'00000000-0000-4000-8000-000000000002'}),
    JSON.stringify({...approved,owner:payTo,payer:payTo}),
    JSON.stringify({...approved,network:'eip155:8453',asset:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'}),
  ]){
    const directory=await mkdtemp(join(tmpdir(),'voidly-allowance-invalid-prepared-test-'));
    const store=new FileSpendAllowanceStore(directory);
    await store.prepare(approved);
    await store.enable(approved);
    await writeFile(markerPath(directory,approved,'prepared'),invalid);
    const restored=new FileSpendAllowanceStore(directory);
    assert.deepEqual(await restored.get(approved.grantId,payer,approved.network),approved);
    await assert.rejects(restored.get(approved.grantId,payer,approved.network,true));
    // Fixtures are retained per owner storage/evidence instructions.
  }
});
