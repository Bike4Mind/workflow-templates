import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest

WORKFLOW = Path(__file__).parents[1] / 'workflows/sst-preview-sweep.yml'

# Fake gh: deployments 101/105 on pr1 (closed), 102 on pr2 (open), 103 on staging,
# 104 on pr3 (PR lookup 404s). Environments pr1, pr2, production, pr3.
FAKE_GH = '''#!/usr/bin/env python3
import os,sys,pathlib
args=sys.argv[1:]; mode=os.environ['MODE']; log=pathlib.Path(os.environ['LOG'])
with log.open('a') as f:f.write(os.environ.get('GH_TOKEN','-')+' '+' '.join(args)+'\\n')
path=next(a for a in args if a.startswith('repos/'))
if '/pulls/' in path:
 n=path.rsplit('/',1)[1]
 if n=='3':print('gh: Not Found (HTTP 404)',file=sys.stderr);sys.exit(1)
 print({'1':'closed','2':'open'}[n]);sys.exit(0)
if path.endswith('/environments?per_page=100'):
 print('pr1\\npr2\\nproduction\\npr3');sys.exit(0)
if '/environments/' in path:
 if mode=='env-delete-failure':print('gh: Forbidden (HTTP 403)',file=sys.stderr);sys.exit(1)
 if mode=='env-gone':print('gh: Not Found (HTTP 404)',file=sys.stderr);sys.exit(1)
 sys.exit(0)
if path.startswith('repos/R/deployments?'):
 if mode=='list-failure':sys.exit(1)
 print('101 pr1\\n102 pr2\\n103 staging\\n104 pr3\\n105 pr1');sys.exit(0)
if mode=='delete-failure' and '-X' in args:sys.exit(1)
'''


def step_script(name, next_marker):
    source = WORKFLOW.read_text()
    step = source.split(f'      - name: {name}\n')[1].split(next_marker)[0]
    return textwrap.dedent(step.split('        run: |\n')[1])


class Harness(unittest.TestCase):
    def run_step(self, script, mode, **env):
        with tempfile.TemporaryDirectory() as tmp:
            cli = Path(tmp) / 'gh'
            cli.write_text(FAKE_GH)
            cli.chmod(0o755)
            log = Path(tmp) / 'calls'
            log.touch()
            summary = Path(tmp) / 'summary'
            full_env = {**os.environ, 'PATH': tmp + ':' + os.environ['PATH'], 'MODE': mode,
                        'LOG': str(log), 'REPO': 'R', 'GITHUB_STEP_SUMMARY': str(summary), **env}
            result = subprocess.run(['bash', '-c', script], env=full_env, capture_output=True, text=True)
            return result, log.read_text().splitlines()


class ClosedPrRecords(Harness):
    script = step_script('Delete deployment records of closed PRs', '      - name: Skip environment deletion')

    def run_records(self, mode='ok', dry='false', cap='150'):
        return self.run_step(self.script, mode, GH_TOKEN='wf', DRY_RUN=dry, MAX_RECORDS=cap)

    def deleted(self, calls):
        return [c.split('/deployments/')[1] for c in calls if 'DELETE' in c]

    def test_deletes_only_records_of_closed_prs(self):
        result, calls = self.run_records()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.deleted(calls), ['101', '105'])
        self.assertEqual(sum('/statuses' in c for c in calls), 2)

    def test_looks_up_each_pr_once(self):
        _, calls = self.run_records()
        self.assertEqual(sum('repos/R/pulls/1 ' in c for c in calls), 1)

    def test_dry_run_deletes_nothing(self):
        result, calls = self.run_records(dry='true')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.deleted(calls), [])
        self.assertIn('would delete deployment 101 (pr1)', result.stdout)

    def test_cap_leaves_the_rest_for_the_next_sweep(self):
        result, calls = self.run_records(cap='1')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.deleted(calls), ['101'])
        self.assertIn('1 left for the next sweep', result.stdout)

    def test_listing_failure_fails_closed(self):
        result, calls = self.run_records(mode='list-failure')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.deleted(calls), [])

    def test_delete_failure_fails_the_step(self):
        result, _ = self.run_records(mode='delete-failure')
        self.assertNotEqual(result.returncode, 0)


class ClosedPrEnvironments(Harness):
    script = step_script('Delete environments of closed PRs', '\n\n')

    def run_envs(self, mode='ok', dry='false'):
        return self.run_step(self.script, mode, APP_TOKEN='app', PR_TOKEN='wf', DRY_RUN=dry)

    def test_deletes_only_closed_pr_environments_with_the_app_token(self):
        result, calls = self.run_envs()
        self.assertEqual(result.returncode, 0, result.stderr)
        deletes = [c for c in calls if 'DELETE' in c]
        self.assertEqual(deletes, ['app api -X DELETE repos/R/environments/pr1'])
        self.assertTrue(all(c.startswith('wf ') for c in calls if '/pulls/' in c))

    def test_dry_run_deletes_nothing(self):
        result, calls = self.run_envs(dry='true')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any('DELETE' in c for c in calls))
        self.assertIn('would delete environment pr1', result.stdout)

    def test_already_gone_is_success(self):
        result, _ = self.run_envs(mode='env-gone')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_other_delete_failure_fails_the_step(self):
        result, _ = self.run_envs(mode='env-delete-failure')
        self.assertNotEqual(result.returncode, 0)


if __name__ == '__main__':
    unittest.main()
