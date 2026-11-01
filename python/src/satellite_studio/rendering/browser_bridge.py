"""Single-worker, single-frame capability bridge; no filesystem paths cross HTTP."""
from __future__ import annotations

import copy
import secrets
import threading
import time

from .browser_renderer import validate_result


class BridgeError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status=status


class BrowserBridge:
    LEASE_S=30
    FRAME_S=90
    POLL_S=.25

    def __init__(self, *, clock=time.monotonic, is_canceled=None):
        self._clock=clock
        self._condition=threading.Condition()
        self._closed=False
        self._worker=None
        self._heartbeat=0.
        self._active=None
        self._is_canceled=is_canceled or (lambda job_id: False)

    def _fail(self, reason):
        if self._active is not None:
            self._active['error']=reason
            self._active=None
        self._condition.notify_all()

    def _expire(self):
        now=self._clock()
        if self._worker and now-self._heartbeat >= self.LEASE_S:
            self._worker=None
            self._fail('网页 worker 心跳租期已过期')
        if self._active and now >= self._active['deadline']:
            self._fail('网页单帧渲染超过 90 秒')

    def _auth(self, token):
        self._expire()
        if not isinstance(token,str) or self._worker is None or not secrets.compare_digest(token,self._worker):
            raise BridgeError(403,'网页 worker 凭证无效或已过期')
        if self._closed:
            raise BridgeError(409,'网页桥接已关闭')

    @property
    def available(self):
        with self._condition:
            self._expire()
            return not self._closed and self._worker is not None

    def register(self):
        with self._condition:
            self._expire()
            if self._closed or self._worker is not None:
                raise BridgeError(409,'网页 worker 已注册或桥接已关闭')
            self._worker=secrets.token_urlsafe(32)
            self._heartbeat=self._clock()
            return {'worker_token':self._worker,'lease_s':30,'heartbeat_interval_s':5}

    def heartbeat(self, token):
        with self._condition:
            self._auth(token)
            self._heartbeat=self._clock()
            return {'ok':True}

    def poll(self, token):
        deadline=time.monotonic()+self.POLL_S
        with self._condition:
            while True:
                self._auth(token)
                active=self._active
                if active and not active['claimed']:
                    active['claimed']=True
                    return {'task':copy.deepcopy(active['task'])}
                remaining=deadline-time.monotonic()
                if remaining <= 0: return {'task':None}
                self._condition.wait(remaining)

    def result(self, body):
        with self._condition:
            self._auth(body.get('worker_token'))
            active=self._active
            if active is None or body.get('task_id') != active['task']['task_id'] or body.get('attempt_token') != active['task']['attempt_token'] or not active['claimed']:
                raise BridgeError(409,'网页渲染尝试已失效或重复')
            if 'error' in body:
                if not isinstance(body['error'],str) or not body['error'] or len(body['error'])>4096 or 'metadata' in body or 'png_base64' in body:
                    raise ValueError('网页错误结果无效')
                self._fail('网页渲染失败: '+body['error'])
                return {'ok':True}
            frame=active['task']['frame']; model=active['task']['model']
        # Decoding has no store lock and does not delay heartbeat or cancellation.
        result=validate_result(body,frame,model)
        with self._condition:
            self._auth(body.get('worker_token'))
            if self._active is not active:
                raise BridgeError(409,'网页渲染尝试已取消或过期')
            active['result']=result
            self._active=None
            self._condition.notify_all()
        return {'ok':True}

    def render(self, frame, model, job_id):
        with self._condition:
            self._expire()
            if self._closed or not self._worker:
                raise RuntimeError('网页出图不可用；请保持工作台打开')
            if self._is_canceled(job_id):
                raise RuntimeError('网页任务已取消')
            if self._active:
                raise RuntimeError('网页桥接已有活动帧')
            active={'task':{'task_id':secrets.token_urlsafe(24),'attempt_token':secrets.token_urlsafe(32),'frame':copy.deepcopy(frame),'model':copy.deepcopy(model)},
                    'job_id':job_id,'deadline':self._clock()+self.FRAME_S,'claimed':False}
            self._active=active
            self._condition.notify_all()
            while 'result' not in active and 'error' not in active:
                self._expire()
                if 'error' in active: break
                self._condition.wait(.1)
            if 'error' in active: raise RuntimeError(active['error'])
            return active['result']

    def cancel(self, job_id):
        with self._condition:
            if self._active and self._active['job_id']==job_id:
                self._fail('网页任务已取消')

    def release(self, token):
        with self._condition:
            self._auth(token)
            self._worker=None
            self._fail('网页 worker 已释放')
            return {'ok':True}

    def close(self):
        with self._condition:
            self._closed=True
            self._fail('网页桥接已关闭')
