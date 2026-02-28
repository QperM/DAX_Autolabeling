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
    checkTables();
  }
});

function checkTables() {
  // 查询所有表
  db.all("SELECT name FROM sqlite_master WHERE type='table'", (err, tables) => {
    if (err) {
      console.error('查询表失败:', err.message);
    } else {
      console.log('\n📋 数据库中的表:');
      tables.forEach(table => {
        console.log(`  - ${table.name}`);
      });
      
      // 检查每个表的结构
      tables.forEach(table => {
        checkTableStructure(table.name);
      });
    }
  });
}

function checkTableStructure(tableName) {
  console.log(`\n🔍 表 ${tableName} 的结构:`);
  db.all(`PRAGMA table_info(${tableName})`, (err, columns) => {
    if (err) {
      console.error(`查询表 ${tableName} 结构失败:`, err.message);
    } else {
      columns.forEach(column => {
        console.log(`  ${column.name} (${column.type}) ${column.dflt_value ? `DEFAULT ${column.dflt_value}` : ''} ${column.pk ? 'PRIMARY KEY' : ''}`);
      });
    }
  });
}

// 关闭数据库连接
setTimeout(() => {
  db.close((err) => {
    if (err) {
      console.error('关闭数据库失败:', err.message);
    } else {
      console.log('\n🔒 数据库连接已关闭');
    }
  });
}, 2000);