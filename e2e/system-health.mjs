// Demo-only registration helper for e2e/run.mjs. No hosted writes, real keys,
// reward initialization or maintenance are performed by browser checks.
import assert from 'node:assert/strict';
import { goto } from './harness.mjs';
export async function checkSystemHealth(page) {
  await goto(page, '/admin');
  const panel = page.getByRole('region', { name: 'System health' });
  await panel.waitFor();
  await page.getByText('Demo only. No connected database or real reward keys have been checked.', {exact:true}).waitFor();
  assert.equal(await panel.getByRole('button', {name:'Initialize reward key protection'}).count(),0);
  assert.equal(await panel.getByRole('button', {name:'Run checks now'}).count(),0);
  await panel.getByRole('button', {name:'Refresh status'}).click();
  await panel.getByText('Demo only. No connected database or real reward keys have been checked.', {exact:true}).waitFor();
}

const FIXTURE_URL='**/api/admin/system-health';
async function fixture(page, status) {
  await page.route(FIXTURE_URL, route => route.fulfill({ status:200, contentType:'application/json', body:JSON.stringify({ demo:false, canary:{status}, summary:null }) }));
  await goto(page,'/admin');
  const panel=page.getByRole('region',{name:'System health',exact:true});
  await panel.getByRole('button',{name:'Run checks now'}).waitFor();
  return panel;
}
export async function systemHealthJourney(page, runner) {
  await runner.step('System health: initialization requires backup acknowledgement and never asks for a key',async()=>{
    try {
      const panel=await fixture(page,'missing'),button=panel.getByRole('button',{name:'Initialize reward key protection'});
      assert.equal(await button.isDisabled(),true);
      await panel.getByRole('checkbox',{name:'I have securely backed up both reward keys and the encryption key version.'}).check();
      assert.equal(await button.isEnabled(),true);
      assert.equal(await panel.locator('input:not([type=checkbox])').count(),0);
    } finally { await page.unroute(FIXTURE_URL); }
  });
  await runner.step('System health: immutable key mismatch offers recovery without replacement initialization',async()=>{
    try {
      const panel=await fixture(page,'mismatch');
      await panel.getByText(/Do not replace the protection record/).waitFor();
      assert.equal(await panel.getByRole('button',{name:'Initialize reward key protection'}).count(),0);
    } finally { await page.unroute(FIXTURE_URL); }
  });
}
export function systemHealthA11yStates(advisory=[]) {
  return ['missing','mismatch','unavailable'].map(status=>({path:null,name:`admin System health (${status})`,context:{},viewport:{width:390,height:844},advisory,prep:page=>fixture(page,status),cleanup:page=>page.unroute(FIXTURE_URL)}));
}
