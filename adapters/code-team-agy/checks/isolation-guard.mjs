import { pathToFileURL } from 'node:url';

const DANGEROUS_PATTERNS = [
  {
    id: 'destructive-rm',
    regex: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(\/|~|\$HOME)(\s|$)/,
    reason: '禁止执行根目录或主目录级破坏性删除命令',
  },
  {
    id: 'prod-db-drop',
    regex: /\b(DROP\s+DATABASE|TRUNCATE\s+TABLE|FLUSHALL|FLUSHDB)\b/i,
    reason: '闸 4 隔离红线：禁止执行高危数据库/Redis 清空操作',
  },
  {
    id: 'prod-dsn-in-test',
    regex: /\b(pytest|cargo\s+test|npm\s+test|vitest|jest|node\s+--test)\b.*?(prod\.|production|rds\.amazonaws\.com|redis:\/\/[^@\s]*prod)/i,
    reason: '闸 4 隔离红线：测试命令禁止直连生产数据库或现场 Redis',
  },
  {
    id: 'k8s-prod-delete',
    regex: /\bkubectl\s+delete\b.*(-n|--namespace)[=\s]+prod/i,
    reason: '闸 4 隔离红线：禁止删除生产命名空间资源',
  },
];

export function checkCommandIsolation(commandLine) {
  if (!commandLine || typeof commandLine !== 'string') {
    return { ok: true, violations: [] };
  }
  const violations = [];
  for (const rule of DANGEROUS_PATTERNS) {
    if (rule.regex.test(commandLine)) {
      violations.push({ id: rule.id, reason: rule.reason });
    }
  }
  return { ok: violations.length === 0, violations };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = process.argv.slice(2).join(' ');
  const res = checkCommandIsolation(cmd);
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.ok ? 0 : 1);
}
