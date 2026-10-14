"""Send a text to the owner's OWN WhatsApp chat through WA Bridge's one unattended path (POST /send/self).

Vault decision 2026-09-27-wa-self-alerts (his grant): automated vault alerts and reminders reach his self-chat
without a confirm. The bridge takes no recipient on this path, so this can never message anyone else; every
message arrives labelled [source]. Claude's own WhatsApp sends stay draft -> his approval -> confirm.

    python machinery/wa_self.py --source vault-health --text "FAIL backup: ..."
    python machinery/wa_self.py --source vault-reminder --file C:/path/to/message.txt

Exit 0 = sent; non-zero = NOT sent (the reason is printed). Import: send_self(text, source) -> (ok, detail).
"""
import argparse
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request

HOST = 'http://127.0.0.1:3210'
TOKEN_FILE = pathlib.Path(os.environ.get('LOCALAPPDATA', '')) / 'wa-bridge' / 'token'


def send_self(text, source):
    try:
        token = TOKEN_FILE.read_text(encoding='utf-8').strip()
    except OSError as e:
        return False, 'no WA Bridge token (%s)' % e
    req = urllib.request.Request(HOST + '/send/self', method='POST',
                                 data=json.dumps({'source': source, 'text': text}).encode('utf-8'),
                                 headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode('utf-8'))
        except Exception:
            return False, 'HTTP %d' % e.code
    except Exception as e:
        return False, 'WA Bridge unreachable: %s' % e
    if body.get('ok') and body.get('status') == 'sent':
        return True, 'sent %s' % body.get('id')
    return False, '%s: %s' % (body.get('error', {}).get('code'), body.get('error', {}).get('message'))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--source', required=True)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--text')
    g.add_argument('--file')
    a = ap.parse_args()
    text = a.text if a.text is not None else pathlib.Path(a.file).read_text(encoding='utf-8-sig')
    ok, detail = send_self(text, a.source)
    print(('SENT ' if ok else 'NOT SENT: ') + detail)
    sys.exit(0 if ok else 1)
