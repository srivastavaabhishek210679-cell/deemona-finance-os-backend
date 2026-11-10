// Loads the .env file before anything else reads settings. Idempotent. Run from the backend folder.
const fs=require('fs');const p='src/index.ts';
let s=fs.readFileSync(p,'utf8');
if(s.includes("import 'dotenv/config';")){console.log('already patched');process.exit(0);}
const bom=s.charCodeAt(0)===0xFEFF; if(bom)s=s.slice(1);
const crlf=s.includes('\r\n');
const nl=crlf?'\r\n':'\n';
s="import 'dotenv/config'; // must be first: other files read settings when they load"+nl+s;
fs.writeFileSync(p,(bom?'﻿':'')+s);console.log('patched',p);
