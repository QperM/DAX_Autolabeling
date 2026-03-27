class RequestQueueLimiter {
  constructor({ key, maxConcurrent = 1, onDebug = null }) {
    this.key = String(key || 'queue');
    this.maxConcurrent = Math.max(1, Number(maxConcurrent || 1));
    this.onDebug = typeof onDebug === 'function' ? onDebug : null;
    this.running = 0;
    this.queue = [];
    this.seq = 0;
    this.tasks = new Map();
    this.sessionActiveTaskId = new Map();
  }

  _debug(stage, data = {}) {
    if (!this.onDebug) return;
    this.onDebug({
      queue: this.key,
      stage,
      running: this.running,
      waiting: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      ...data,
    });
  }

  _newTaskId() {
    this.seq += 1;
    return `${this.key}-${Date.now()}-${this.seq}`;
  }

  _queuePosition(taskId) {
    const idx = this.queue.findIndex((x) => x.taskId === taskId);
    return idx >= 0 ? idx + 1 : null;
  }

  getTaskStatus(taskId) {
    const task = this.tasks.get(String(taskId || ''));
    if (!task) return null;
    const status = {
      taskId: task.taskId,
      queueKey: this.key,
      state: task.state,
      maxConcurrent: this.maxConcurrent,
      running: this.running,
      waiting: this.queue.length,
      queuePosition: task.state === 'queued' ? this._queuePosition(task.taskId) : null,
      queuedAt: task.queuedAt,
      startedAt: task.startedAt || null,
      endedAt: task.endedAt || null,
      error: task.error || null,
    };
    if (task.state === 'done') status.result = task.result;
    return status;
  }

  getSessionStatus(sessionId) {
    const sid = String(sessionId || '');
    if (!sid) return { active: false };
    const taskId = this.sessionActiveTaskId.get(sid);
    if (!taskId) return { active: false };
    const s = this.getTaskStatus(taskId);
    if (!s) return { active: false };
    return { active: true, ...s };
  }

  enqueue({ sessionId, payload, worker }) {
    if (typeof worker !== 'function') throw new Error('worker is required');
    const sid = String(sessionId || '');
    if (!sid) throw new Error('sessionId is required');

    const existingTaskId = this.sessionActiveTaskId.get(sid);
    if (existingTaskId) {
      const existing = this.tasks.get(existingTaskId);
      if (existing && (existing.state === 'queued' || existing.state === 'running')) {
        this._debug('reuse-active-task', { taskId: existingTaskId, sessionId: sid, state: existing.state });
        return { taskId: existingTaskId, reused: true, promise: existing.promise };
      }
    }

    const taskId = this._newTaskId();
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const task = {
      taskId,
      sessionId: sid,
      payload,
      worker,
      state: 'queued',
      queuedAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      result: null,
      error: null,
      promise,
      resolvePromise,
      rejectPromise,
    };
    this.tasks.set(taskId, task);
    this.sessionActiveTaskId.set(sid, taskId);
    this.queue.push(task);
    this._debug('enqueued', { taskId, sessionId: sid, queuePosition: this._queuePosition(taskId) });
    this._pump();
    return { taskId, reused: false, promise };
  }

  _pump() {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task || task.state !== 'queued') continue;
      this._runTask(task);
    }
  }

  async _runTask(task) {
    this.running += 1;
    task.state = 'running';
    task.startedAt = new Date().toISOString();
    this._debug('started', { taskId: task.taskId, sessionId: task.sessionId });
    try {
      const out = await task.worker(task.payload, task);
      task.result = out;
      task.state = 'done';
      task.endedAt = new Date().toISOString();
      this._debug('done', { taskId: task.taskId, sessionId: task.sessionId });
      task.resolvePromise(out);
    } catch (e) {
      task.error = e?.message || String(e);
      task.state = 'failed';
      task.endedAt = new Date().toISOString();
      this._debug('failed', { taskId: task.taskId, sessionId: task.sessionId, error: task.error });
      task.rejectPromise(e);
    } finally {
      this.running = Math.max(0, this.running - 1);
      const current = this.sessionActiveTaskId.get(task.sessionId);
      if (current === task.taskId) this.sessionActiveTaskId.delete(task.sessionId);
      this._pump();
    }
  }
}

module.exports = { RequestQueueLimiter };
