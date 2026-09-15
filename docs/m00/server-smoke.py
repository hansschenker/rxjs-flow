import http.client
import json
import os
import pathlib
import signal
import shutil
import socket
import subprocess
import sys
import time

cwd = str(pathlib.Path(__file__).resolve().parents[2])
node = shutil.which('node')
if node is None:
    raise RuntimeError('Node 22.22.1 is required but node was not found')
node_version = subprocess.check_output([node, '--version'], text=True).strip()
if node_version != 'v22.22.1':
    raise RuntimeError(f'Node 22.22.1 is required; found {node_version}')
command = [node, *sys.argv[1:]]
with socket.socket() as check:
    check.bind(('127.0.0.1', 3000))
env = os.environ.copy()
env['PATH'] = str(pathlib.Path(node).parent) + ':' + env['PATH']
child = subprocess.Popen(command, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
try:
    deadline = time.monotonic() + 5
    while True:
        try:
            connection = http.client.HTTPConnection('127.0.0.1', 3000, timeout=0.5)
            connection.request('GET', '/health')
            response = connection.getresponse()
            health = [response.status, json.loads(response.read())]
            connection.close()
            break
        except (OSError, http.client.HTTPException):
            if time.monotonic() > deadline or child.poll() is not None:
                raise
            time.sleep(0.02)
    if health != [200, {'status': 'ok'}]:
        raise ValueError(f'Invalid health response: {health!r}')
    connection = http.client.HTTPConnection('127.0.0.1', 3000, timeout=2)
    connection.request('GET', '/todos')
    response = connection.getresponse()
    todos = [response.status, json.loads(response.read())]
    connection.close()
    if todos[0] != 200 or not isinstance(todos[1], list):
        raise ValueError(f'Invalid Todo list response: {todos!r}')
    if not all(isinstance(todo, dict) and isinstance(todo.get('id'), str) and isinstance(todo.get('title'), str) and isinstance(todo.get('completed'), bool) for todo in todos[1]):
        raise ValueError(f'Invalid Todo fields: {todos!r}')
    print(json.dumps({'command':command,'health':health,'todos':todos,'smoke':'passed'}))
finally:
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
    try:
        output, _ = child.communicate(timeout=3)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        output, _ = child.communicate()
    print(output)
