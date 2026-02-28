const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// 数据库文件路径
const dbPath = path.join(__dirname, '../database', 'annotations.db');

// 创建数据库连接
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
  } else {
    console.log('✅ 数据库连接成功');
    showDatabaseInfo();
  }
});

function showDatabaseInfo() {
  console.log('\n=== 数据库概览 ===');
  
  // 显示所有表
  db.all("SELECT name FROM sqlite_master WHERE type='table'", (err, tables) => {
    if (err) {
      console.error('查询表失败:', err.message);
    } else {
      console.log('\n📋 数据库中的表:');
      const tableNames = tables.map(t => t.name);
      tableNames.forEach(name => console.log(`  • ${name}`));
      
      // 显示每个表的数据统计
      showTableStats(tableNames);
    }
  });
}

function showTableStats(tableNames) {
  let completed = 0;
  
  tableNames.forEach(tableName => {
    db.get(`SELECT COUNT(*) as count FROM ${tableName}`, (err, result) => {
      if (err) {
        console.error(`查询表 ${tableName} 失败:`, err.message);
      } else {
        console.log(`📊 ${tableName} 表: ${result.count} 条记录`);
        
        // 如果有数据，显示前几条记录的示例
        if (result.count > 0) {
          showSampleData(tableName);
        }
      }
      
      completed++;
      if (completed === tableNames.length) {
        setTimeout(() => {
          db.close(() => console.log('\n🔒 数据库连接已关闭'));
        }, 1000);
      }
    });
  });
}

function showSampleData(tableName) {
  console.log(`\n🔍 ${tableName} 表示例数据 (前3条):`);
  
  db.all(`SELECT * FROM ${tableName} LIMIT 3`, (err, rows) => {
    if (err) {
      console.error(`查询 ${tableName} 数据失败:`, err.message);
    } else {
      rows.forEach((row, index) => {
        console.log(`  记录 ${index + 1}:`, JSON.stringify(row, null, 2));
      });
    }
  });
}

// 错误处理
process.on('uncaughtException', (err) => {
  console.error('未捕获的异常:', err);
  db.close(() => process.exit(1));
});