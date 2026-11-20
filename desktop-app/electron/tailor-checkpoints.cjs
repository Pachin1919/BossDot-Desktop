'use strict';

const { DatabaseSync } = require('node:sqlite');

function openTailorCheckpoints(file) {
  const database = new DatabaseSync(file);
  database.exec('CREATE TABLE IF NOT EXISTS tailor_checkpoints (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL)');
  const read = database.prepare('SELECT snapshot FROM tailor_checkpoints WHERE id = ?');
  const write = database.prepare(`
    INSERT INTO tailor_checkpoints (id, snapshot) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET snapshot = excluded.snapshot
  `);
  const checkId = (id) => {
    if (typeof id !== 'string' || !/^resume-[0-9a-f]{64}$/.test(id)) throw new Error('定制简历任务编号不合法');
  };
  return {
    read(id) {
      checkId(id);
      return read.get(id)?.snapshot ?? null;
    },
    write(id, snapshot) {
      checkId(id);
      if (typeof snapshot !== 'string' || !snapshot || snapshot.length > 12 * 1024 * 1024) {
        throw new Error('定制简历检查点超出本地存储限制');
      }
      write.run(id, snapshot);
    },
    close: () => database.close(),
  };
}

module.exports = { openTailorCheckpoints };
