from pathlib import Path
import unittest

WORKFLOWS = Path(__file__).parents[1] / 'workflows'


class NotifyWiring(unittest.TestCase):
    def test_cleanup_reports_whether_the_stage_was_removed(self):
        cleanup = (WORKFLOWS / 'sst-preview-cleanup.yml').read_text()
        self.assertIn('stage_removed: ${{ steps.removed.outputs.stage_removed }}', cleanup)
        self.assertIn("if: steps.guard.outputs.has_app == 'false' || steps.remove.outcome == 'success'", cleanup)
        self.assertIn("stage_removed: ${{ needs.cleanup.outputs.stage_removed == 'true' }}", cleanup)

    def test_alert_distinguishes_github_only_failures(self):
        notify = (WORKFLOWS / 'notify-cleanup-failure.yml').read_text()
        self.assertIn('stage_removed:', notify)
        self.assertIn('type: boolean', notify)
        self.assertIn('inputs.stage_removed &&', notify)
        self.assertIn('no AWS resources are orphaned', notify)
        self.assertIn('may be orphaned and consuming AWS resources', notify)


if __name__ == '__main__':
    unittest.main()
