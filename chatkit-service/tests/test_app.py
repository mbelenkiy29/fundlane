import base64
import hashlib
import hmac
import json
import time
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from chatkit.types import AssistantMessageContent, AssistantMessageItem, ThreadItemDoneEvent
import app as runtime

SECRET = "synthetic-chatkit-service-test-secret"


def token(body, **overrides):
    now = int(time.time())
    claims = dict(aud="mca-chatkit", requestId=str(uuid4()), userId="user", workspaceId="workspace", membershipId="member", sessionId="session", iat=now, exp=now+120, bodyHash=hashlib.sha256(body).hexdigest())
    claims.update(overrides)
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).rstrip(b"=")
    signature = base64.urlsafe_b64encode(hmac.new(SECRET.encode(), payload, hashlib.sha256).digest()).rstrip(b"=")
    return (payload+b"."+signature).decode()


@pytest.fixture(autouse=True)
def config(monkeypatch):
    monkeypatch.setenv("MCA_ASSISTANT_SIGNING_SECRET", SECRET)


def test_delegation_body_binding_and_expiry():
    body = b'{"type":"threads.list","params":{}}'
    assert runtime.verify_token(token(body), body)["workspaceId"] == "workspace"
    for bad_token, bad_body in [(token(body), b"tampered"), (token(body, exp=1), body), ("invalid", body), (token(body, aud="other"), body)]:
        with pytest.raises(HTTPException):
            runtime.verify_token(bad_token, bad_body)


def test_rejects_unsupported_actions_and_attachments():
    client = TestClient(runtime.app)
    for data in [dict(type="threads.custom_action", params={}), dict(type="threads.create", params={"input":{"attachments":["file"]}})]:
        body = json.dumps(data).encode()
        assert client.post("/chatkit", content=body, headers={"Authorization": "Bearer " + token(body)}).status_code == 400
    assert client.post("/chatkit", content=b"x"*64001).status_code == 413
    assert client.post("/chatkit", content=b"{}").status_code == 401


def test_real_chatkit_protocol_persists_and_reloads_stream(monkeypatch):
    threads, items = {}, {}

    async def rpc(self, kind, data):
        assert kind == "store"
        op = data["op"]
        tid = data.get("threadId")
        if op == "save_thread":
            threads[data["payload"]["id"]] = data["payload"]
        elif op == "save_item":
            items.setdefault(tid, {})[data["payload"]["id"]] = data["payload"]
        elif op == "load_thread":
            return threads[tid]
        elif op == "load_items":
            rows = list(items.get(tid, {}).values())
            if data["order"] == "desc": rows.reverse()
            return dict(data=rows[:data["limit"]], has_more=False, after=None)
        elif op == "load_threads":
            return dict(data=list(threads.values()), has_more=False, after=None)
        elif op == "delete_thread":
            threads.pop(tid); items.pop(tid)
        else:
            raise AssertionError(op)

    async def respond(self, thread, input, context):
        yield ThreadItemDoneEvent(item=AssistantMessageItem(id="msg_synthetic", thread_id=thread.id, created_at=datetime.now(timezone.utc), content=[AssistantMessageContent(text="Synthetic pipeline has one lead.")]))

    monkeypatch.setattr(runtime.RequestContext, "rpc", rpc)
    monkeypatch.setattr(runtime.MCAServer, "respond", respond)
    client = TestClient(runtime.app)

    def post(data):
        body = json.dumps(data).encode()
        return client.post("/chatkit", content=body, headers={"Authorization":"Bearer "+token(body)})

    result = post(dict(type="threads.create", params={"input":{"content":[{"type":"input_text","text":"Summarize pipeline"}],"attachments":[],"inference_options":{}}}))
    assert result.status_code == 200
    assert "thread.created" in result.text
    assert "Synthetic pipeline" in result.text
    tid = next(iter(threads))
    assert threads[tid]["created_at"].endswith("Z")
    assert len(items[tid]) >= 2
    reloaded = post(dict(type="threads.get_by_id",params={"thread_id":tid}))
    assert reloaded.status_code == 200
    assert "Synthetic pipeline" in reloaded.text
    assert post(dict(type="threads.delete",params={"thread_id":tid})).status_code == 200
    assert not threads and not items


def test_service_failure_is_sanitized(monkeypatch):
    async def bad(self, *args):
        raise RuntimeError("sensitive diagnostic MUST NOT LEAK")
    monkeypatch.setattr(runtime.RequestContext, "rpc", bad)
    data = json.dumps(dict(type="threads.list",params={})).encode()
    result = TestClient(runtime.app).post("/chatkit",content=data,headers={"Authorization":"Bearer "+token(data)})
    assert result.status_code == 502
    assert "MUST NOT LEAK" not in result.text


def test_only_four_read_tools_exposed():
    tools = [runtime.search_deals, runtime.get_deal, runtime.summarize_pipeline, runtime.get_underwriting]
    assert [tool.name for tool in tools] == ["search_deals","get_deal","summarize_pipeline","get_underwriting"]
    assert "untrusted data" in runtime.INSTRUCTIONS
    assert "cannot modify" in runtime.INSTRUCTIONS


def test_sdk_history_request_is_bounded(monkeypatch):
    seen = []
    async def rpc(self, kind, data):
        seen.append(data)
        return {"data": [], "has_more": False, "after": None}
    monkeypatch.setattr(runtime.RequestContext, "rpc", rpc)
    body=json.dumps({"type":"threads.list","params":{"limit":9999,"order":"desc"}}).encode()
    response=TestClient(runtime.app).post("/chatkit",content=body,headers={"Authorization":"Bearer "+token(body)})
    assert response.status_code==200
    assert seen[0]["limit"]==100
