// CLI for operations and external cron:
//   npm run job -- report [--email]        generate the daily report
//   npm run job -- prospect                run the prospecting sweep now
//   npm run job -- follow-ups              prepare follow-up drafts now
//   npm run job -- procurement             run the procurement scan now
//   npm run set-password -- <email> <pw>   create/reset the owner login
import { assertBootConfig } from '../config.js';
import { getDb, get } from '../db.js';
import { upsertUser } from '../auth.js';
import { seedSchedules, runSchedule } from './scheduler.js';
import { generateDailyReport } from './daily-report.js';

assertBootConfig();
getDb();
const [cmd, ...args] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case 'set-password': {
      const [email, password] = args;
      upsertUser(email, password);
      console.log(`Owner login set for ${email}`);
      break;
    }
    case 'report': {
      const r = await generateDailyReport({ email: args.includes('--email') });
      console.log(r.markdown);
      if (r.email_error) console.error(`Email not sent: ${r.email_error}`);
      break;
    }
    case 'prospect':
    case 'follow-ups':
    case 'procurement': {
      seedSchedules();
      const kind = { prospect: 'prospect', 'follow-ups': 'follow_up', procurement: 'procurement' }[cmd];
      const s = get('SELECT * FROM schedules WHERE kind = ?', kind);
      const res = await runSchedule(s, 'cli');
      console.log(res.ok ? res.text || 'Done.' : `Failed: ${res.error}`);
      process.exitCode = res.ok ? 0 : 1;
      break;
    }
    default:
      console.log('Usage: npm run job -- <report [--email] | prospect | follow-ups | procurement>\n       npm run set-password -- <email> <password>');
      process.exitCode = 1;
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
