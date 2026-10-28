#!/usr/bin/env node
/**
 * Emergency recovery when the admin is locked out.
 *
 *   node scripts/reset-admin.js            forget the admin account only
 *   node scripts/reset-admin.js --room     also forget the private room key
 *   node scripts/reset-admin.js --all      forget every credential
 *
 * Chat history and uploaded files are never touched. But be aware:
 *
 *   • dropping the admin account keeps the private room key, so every existing
 *     encrypted message stays readable. The website shows the setup wizard on
 *     the next load and asks for a new admin only.
 *   • dropping the room key makes every private message permanently
 *     unreadable — that is unavoidable, the server never held the key.
 *
 * Run it inside the container if you deploy with Docker:
 *   docker exec -it anon-chat node scripts/reset-admin.js
 */
const readline = require('readline');
const auth = require('../auth-store');

const args = process.argv.slice(2);
const wantsRoom = args.includes('--room');
const wantsAll = args.includes('--all');

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(String(answer).trim()));
    });
  });
}

async function main() {
  const before = auth.bootstrap();
  console.log('Anon Chat credential reset');
  console.log('  config file :', auth.CONFIG_FILE);
  console.log('  admin       :', before.needAdmin ? '(none)' : auth.adminUsername());
  console.log('  room key    :', before.room ? 'id #' + before.room.kid : '(none)');
  console.log('');

  if (wantsAll) {
    const ok = await confirm('This forgets the admin AND the private room key.\n'
      + 'Every encrypted private message becomes permanently unreadable.\n'
      + 'Type "yes" to continue: ');
    if (!ok) return console.log('Aborted.');
    auth.resetSetup();
    console.log('✅ All credentials forgotten. Reload the site to run the setup wizard.');
    return;
  }

  if (!auth.hasAdmin()) {
    console.log('No admin account is stored — the setup wizard will run on the next page load.');
  } else {
    const ok = await confirm('Forget the admin account "' + auth.adminUsername() + '"?\n'
      + 'The private room key and all encrypted messages are kept.\n'
      + 'Type "yes" to continue: ');
    if (!ok) return console.log('Aborted.');
    auth.clearAdmin();
    console.log('✅ Admin account removed. Reload the site to create a new one.');
  }

  if (wantsRoom) {
    const ok = await confirm('\nAlso forget the private room key?\n'
      + 'Every encrypted private message becomes permanently unreadable.\n'
      + 'Type "yes" to continue: ');
    if (ok) {
      auth.clearRoom();
      console.log('✅ Private room key removed. A new one will be created by the wizard.');
    } else {
      console.log('Room key kept.');
    }
  }
}

main().catch((err) => {
  console.error('Reset failed:', err.message);
  process.exit(1);
});
