import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const target=resolve(process.argv[2]||'./backups');mkdirSync(target,{recursive:true});
const source=resolve(process.env.DATA_DIR||'./data','player.sqlite');
const file=resolve(target,`player-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`);
const db=new DatabaseSync(source,{readOnly:true});db.prepare('VACUUM INTO ?').run(file);db.close();console.log(file);
