import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest

WORKFLOW = Path(__file__).parents[1] / 'workflows/sst-preview-cleanup.yml'


class DeploymentCleanup(unittest.TestCase):
    def run_cleanup(self, mode):
        source = WORKFLOW.read_text()
        step = source.split('      - name: Delete preview deployment records\n')[1].split('      - uses: actions/create-github-app-token')[0]
        self.assertIn('GH_TOKEN: ${{ github.token }}', step)
        script = textwrap.dedent(step.split('        run: |\n')[1])
        with tempfile.TemporaryDirectory() as tmp:
            cli = Path(tmp) / 'gh'
            cli.write_text('''#!/usr/bin/env python3
import os,sys,pathlib
args=sys.argv[1:]; mode=os.environ['MODE']; log=pathlib.Path(os.environ['LOG'])
with log.open('a') as f:f.write(' '.join(args)+'\\n')
if '-X' not in args:
 assert '--paginate' in args
 if mode=='list-failure':sys.exit(1)
 if mode in('server-error-once','client-error') and log.read_text().count('--paginate')==1:
  print('gh: Server Error (HTTP 502)' if mode=='server-error-once' else 'gh: Not Found (HTTP 404)',file=sys.stderr);sys.exit(1)
 if not pathlib.Path(str(log)+'.deleted').exists() or mode=='remaining':
  if mode!='empty':print('101\\n202')
elif 'POST' in args:
 if mode=='status-failure':sys.exit(1)
elif 'DELETE' in args:
 if mode=='delete-failure':sys.exit(1)
 pathlib.Path(str(log)+'.deleted').touch()
''')
            cli.chmod(0o755)
            log = Path(tmp) / 'calls'
            result = subprocess.run(['bash', '-c', script], env={**os.environ, 'PATH': tmp+':'+os.environ['PATH'], 'MODE': mode, 'LOG': str(log), 'REPO': 'Bike4Mind/fixture', 'PR_NUMBER': '9'}, capture_output=True)
            return result.returncode, log.read_text()

    def test_removes_all_records_and_verifies_empty(self):
        code, calls = self.run_cleanup('success')
        self.assertEqual(code, 0)
        self.assertIn('/deployments/101/statuses', calls)
        self.assertIn('/deployments/202/statuses', calls)
        self.assertEqual(calls.count('--paginate'), 2)

    def test_empty_is_idempotent(self):
        code, calls = self.run_cleanup('empty')
        self.assertEqual(code, 0)
        self.assertNotIn('-X', calls)

    def test_server_error_is_retried(self):
        code, calls = self.run_cleanup('server-error-once')
        self.assertEqual(code, 0)
        self.assertEqual(calls.count('--paginate'), 3)
        self.assertIn('/deployments/101/statuses', calls)

    def test_client_error_is_not_retried(self):
        code, calls = self.run_cleanup('client-error')
        self.assertNotEqual(code, 0)
        self.assertEqual(calls.count('--paginate'), 1)

    def test_api_failures_and_remaining_records_fail_closed(self):
        for mode in ['list-failure', 'status-failure', 'delete-failure', 'remaining']:
            with self.subTest(mode=mode):
                self.assertNotEqual(self.run_cleanup(mode)[0], 0)


class EnvironmentCleanup(unittest.TestCase):
    def run_cleanup(self, mode):
        source = WORKFLOW.read_text()
        step = source.split('      - name: Delete GitHub Environment\n')[1].split('      - name: Comment PR with cleanup confirmation')[0]
        script = textwrap.dedent(step.split('        run: |\n')[1])
        with tempfile.TemporaryDirectory() as tmp:
            cli = Path(tmp) / 'gh'
            cli.write_text('''#!/usr/bin/env python3
import os,sys,pathlib
args=sys.argv[1:]; mode=os.environ['MODE']; log=pathlib.Path(os.environ['LOG'])
assert args[:3]==['api','-X','DELETE'] and '/environments/pr9' in args[3]
with log.open('a') as f:f.write(' '.join(args)+'\\n')
calls=log.read_text().count('DELETE')
if mode=='not-found':print('gh: Not Found (HTTP 404)',file=sys.stderr);sys.exit(1)
if mode=='forbidden':print('gh: Resource not accessible by integration (HTTP 403)',file=sys.stderr);sys.exit(1)
if mode=='server-error-once' and calls==1:print('gh: Server Error (HTTP 502)',file=sys.stderr);sys.exit(1)
if mode=='server-error-always':print('gh: Server Error (HTTP 502)',file=sys.stderr);sys.exit(1)
''')
            cli.chmod(0o755)
            log = Path(tmp) / 'calls'
            result = subprocess.run(['bash', '-c', script], env={**os.environ, 'PATH': tmp+':'+os.environ['PATH'], 'MODE': mode, 'LOG': str(log), 'REPO': 'Bike4Mind/fixture', 'PR_NUMBER': '9'}, capture_output=True, text=True)
            return result.returncode, log.read_text().count('DELETE'), result.stdout

    def test_deletes(self):
        code, calls, out = self.run_cleanup('success')
        self.assertEqual((code, calls), (0, 1))
        self.assertIn('deleted', out)

    def test_not_found_is_success_without_retry(self):
        code, calls, out = self.run_cleanup('not-found')
        self.assertEqual((code, calls), (0, 1))
        self.assertIn('already gone', out)

    def test_server_error_is_retried(self):
        code, calls, out = self.run_cleanup('server-error-once')
        self.assertEqual((code, calls), (0, 2))
        self.assertIn('deleted', out)

    def test_other_failure_fails_closed_without_retry(self):
        code, calls, _ = self.run_cleanup('forbidden')
        self.assertEqual((code, calls), (1, 1))

    def test_persistent_server_error_fails_after_five_attempts(self):
        code, calls, _ = self.run_cleanup('server-error-always')
        self.assertEqual((code, calls), (1, 5))


if __name__ == '__main__':
    unittest.main()
