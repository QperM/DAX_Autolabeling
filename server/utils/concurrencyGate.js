class ConcurrencyGate {
  constructor({ key, maxConcurrent = 1, onDebug = null }) {
    this.key = String(key || 'gate');
    this.maxConcurrent = Math.max(1, Number(maxConcurrent || 1));
    this.onDebug = typeof onDebug === 'function' ? onDebug : null;
    this.running = 0;
    this.queue = [];
    this.seq = 0;
    this.tasks = new Map();
    this.sessionTask = new Map();
  }

  _debug(stage, data = {}) {
    if (!this.onDebug) return;
    this.onDebug({ queue: this.key, stage, running: this.running, waiting: this.queue.length, maxConcurrent: this.maxConcurrent, ...data });
  }

  _newTaskId() {
    this.seq += 1;
    return `${this.key}-${Date.now()}-${this.seq}`;
  }

  _queuePos(taskId) {
    const idx = this.queue.findIndex((x) => x.taskId === taskId);
    return idx >= 0 ? idx + 1 : null;
  }

  getSessionStatus(sessionId) {
    const sid = String(sessionId || '');
    const taskId = this.sessionTask.get(sid);
    if (!taskId) return { active: false };
    const task = this.tasks.get(taskId);
    if (!task) return { active: false };
    return {
      active: true,
      taskId,
      queueKey: this.key,
      state: task.state,
      queuePosition: task.state === 'queued' ? this._queuePos(taskId) : null,
      running: this.running,
      waiting: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      queuedAt: task.queuedAt,
      startedAt: task.startedAt || null,
    };
  }

  async enter(sessionId) {
    const sid = String(sessionId || '');
    if (!sid) throw new Error('sessionId is required');
    const existingTaskId = this.sessionTask.get(sid);
    if (existingTaskId) {
      const t = this.tasks.get(existingTaskId);
      if (t && (t.state === 'queued' || t.state === 'running')) {
        throw new Error('该会话已有进行中任务');
      }
    }

    const taskId = this._newTaskId();
    const task = {
      taskId,
      sessionId: sid,
      state: 'queued',
      queuedAt: new Date().toISOString(),
      startedAt: null,
      _resolve: null,
    };
    const acquired = new Promise((resolve) => {
      task._resolve = resolve;
    });

    this.tasks.set(taskId, task);
    this.sessionTask.set(sid, taskId);
    this.queue.push(task);
    this._debug('enqueued', { taskId, sessionId: sid, queuePosition: this._queuePos(taskId) });
    this._pump();
    await acquired;

    const release = () => {
      const cur = this.tasks.get(taskId);
      if (!cur || cur.state !== 'running') return;
      cur.state = 'done';
      this.running = Math.max(0, this.running - 1);
      const sidNow = cur.sessionId;
      if (this.sessionTask.get(sidNow) === taskId) this.sessionTask.delete(sidNow);
      this._debug('released', { taskId, sessionId: sidNow });
      this._pump();
    };

    return { taskId, release };
  }

  _pump() {
    while (this.running < this.maxConcurrent && this.queue.length) {
      const t = this.queue.shift();
      if (!t || t.state !== 'queued') continue;
      t.state = 'running';
      t.startedAt = new Date().toISOString();
      this.running += 1;
      this._debug('started', { taskId: t.taskId, sessionId: t.sessionId });
      if (typeof t._resolve === 'function') t._resolve();
    }
  }
}

module.exports = { ConcurrencyGate };

