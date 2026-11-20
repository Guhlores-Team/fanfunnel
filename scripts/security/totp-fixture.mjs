// Test-fixture TOTP only. Secrets/codes stay in memory and must never be logged.
import { createHmac } from 'node:crypto';
/** @param {string} secret @param {number} [timeMs] @param {6|8} [digits] */
export function fixtureTotp(secret,timeMs=Date.now(),digits=6) {
  if(typeof secret!=='string')throw Error('invalid TOTP fixture input');
  const text=secret.trim().toUpperCase();
  if(!/^[A-Z2-7]+={0,6}$/.test(text)||!Number.isFinite(timeMs)||timeMs<0||![6,8].includes(digits))throw Error('invalid TOTP fixture input');
  let bits=0,buffer=0;const bytes=[];
  for(const char of text.replace(/=+$/,'')) {
    buffer=(buffer<<5)|'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char);bits+=5;
    if(bits>=8){bits-=8;bytes.push((buffer>>>bits)&255);buffer&=(1<<bits)-1;}
  }
  const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(timeMs/30000)));
  const digest=createHmac('sha1',Buffer.from(bytes)).update(counter).digest();
  const offset=digest[digest.length-1]&15;
  return String((digest.readUInt32BE(offset)&0x7fffffff)%(10**digits)).padStart(digits,'0');
}
