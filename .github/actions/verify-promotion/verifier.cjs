module.exports = async function verifyPromotion({github, context, core, env = process.env}) {
const { PROMOTION_SHA: sha, PROMOTION_ACTOR: actor, REQUIRED_CHECKS: checks, STAGING_ENV: staging, POLICY_PATH: policyPath, POLICY_DIGEST: policyDigest } = env;
const enabled = Boolean(sha || actor || checks || policyPath || policyDigest);
core.setOutput('enabled', String(enabled));
if (!enabled) return;
const deny = reason => { throw new Error(`Promotion denied: ${reason}`); };
if (!/^[a-z0-9][a-z0-9-]*\[bot\]$/.test(actor || '')) deny('trusted console bot must be configured');
core.info(`Promotion request actor=${context.actor} expected=${actor} sha=${sha} ref=${context.ref}`);
if (context.eventName !== 'workflow_dispatch' || context.ref !== 'refs/heads/main' || context.payload.inputs?.tier !== 'production') deny('production dispatch on main required');
if (context.actor !== actor || env.TRIGGERING_ACTOR !== actor) deny('untrusted actor or rerun initiator');
if (!/^[a-f0-9]{40}$/.test(sha || '')) deny('full lowercase SHA required');
if (!staging?.trim()) deny('staging environment required');
let required;
try { required = JSON.parse(checks); } catch { deny('invalid required checks'); }
if (!Array.isArray(required) || !required.length || required.some(name => typeof name !== 'string' || !name.trim()) || new Set(required).size !== required.length) deny('nonempty unique check names required');
const repo = context.repo;
let mainSha;
try { mainSha = (await github.rest.repos.getBranch({ ...repo, branch: 'main' })).data.commit?.sha; } catch {}
if (!/^[a-f0-9]{40}$/.test(mainSha || '')) deny('trusted main commit unavailable');
if (policyPath || policyDigest) {
  if (!policyPath || !policyDigest || !/^[a-f0-9]{64}$/.test(policyDigest)) deny('policy path and lowercase digest required');
  const segments = policyPath.split('/');
  if (policyPath.length > 240 || !policyPath.endsWith('.json') || segments.some(segment => !/^[A-Za-z0-9_.-]+$/.test(segment) || ['.', '..', '.git'].includes(segment))) deny('invalid policy path');
  const validName = name => typeof name === 'string' && name.length > 0 && name.length <= 160 && name.trim() === name && !/[\u0000-\u001f\u007f]/.test(name);
  if (required.length > 32 || required.some(name => !validName(name))) deny('invalid policy baseline checks');
  let file;
  try {
    file = (await github.rest.repos.getContent({ ...repo, path: policyPath, ref: mainSha })).data;
  } catch { deny('trusted main policy unavailable'); }
  if (!file || file.type !== 'file' || file.path !== policyPath || file.target || file.submodule_git_url || file.encoding !== 'base64' || !/^[a-f0-9]{40}$/.test(file.sha || '') || !Number.isInteger(file.size) || file.size > 16384 || typeof file.content !== 'string' || file.content.length > 23000) deny('bounded policy file required');
  let policy;
  try {
    const bytes = Buffer.from(file.content, 'base64');
    if (bytes.length > 16384 || bytes.length !== file.size) deny('policy size mismatch');
    policy = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { deny('policy must be valid bounded UTF-8 JSON'); }
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).sort().join(',') !== 'additionalRequiredChecks,version' || policy.version !== 1 || !Array.isArray(policy.additionalRequiredChecks) || policy.additionalRequiredChecks.length > 32 || policy.additionalRequiredChecks.some(name => !validName(name))) deny('unsupported policy schema');
  required = [...new Set([...required, ...policy.additionalRequiredChecks])].sort();
  if (required.length > 64) deny('too many effective checks');
  const digest = require('node:crypto').createHash('sha256').update(JSON.stringify(required), 'utf8').digest('hex');
  if (digest !== policyDigest) deny('effective policy changed; recreate approval');
  core.setOutput('policy_digest', digest);
  core.setOutput('policy_source_commit', mainSha);
  core.setOutput('policy_blob_sha', file.sha);
  core.info(`Promotion policy source=${mainSha} blob=${file.sha} digest=${digest} checks=${JSON.stringify(required)}`);
}
const comparison = await github.rest.repos.compareCommitsWithBasehead({ ...repo, basehead: `${sha}...${mainSha}` });
if (!['ahead', 'identical'].includes(comparison.data.status)) deny('SHA is not on main');
const deployments = await github.rest.repos.listDeployments({ ...repo, sha, environment: staging, per_page: 1 });
const deployment = deployments.data[0];
if (!deployment || deployment.sha !== sha || deployment.ref !== sha || deployment.creator?.login !== 'github-actions[bot]') deny('trusted staging deployment missing');
const statuses = await github.paginate(github.rest.repos.listDeploymentStatuses, { ...repo, deployment_id: deployment.id, per_page: 100 });
const latest = statuses.find(status => status.state !== 'inactive');
if (latest?.state !== 'success' || latest?.creator?.login !== 'github-actions[bot]') deny('latest staging result is not trusted success');
const runs = await github.paginate(github.rest.checks.listForRef, { ...repo, ref: sha, filter: 'all', per_page: 100 });
const sources = new Map();
const sourceJobs = new Map();
const trustedRuns = [];
for (const run of runs.filter(run => required.includes(run.name))) {
  if (run.app?.id !== 15368) deny(`untrusted check provider: ${run.name}`);
  const runId = run.details_url?.match(/\/actions\/runs\/(\d+)(?:\/|$)/)?.[1];
  if (!runId) deny(`check source run missing: ${run.name}`);
  if (!sources.has(runId)) sources.set(runId, (await github.rest.actions.getWorkflowRun({ ...repo, run_id: Number(runId) })).data);
  const source = sources.get(runId);
  if (source.event !== 'push' || source.head_branch !== 'main' || source.head_sha !== sha) continue;
  // details_url only names the run. The check counts when that run's own job list contains it.
  if (!sourceJobs.has(runId)) sourceJobs.set(runId, await github.paginate(github.rest.actions.listJobsForWorkflowRun, { ...repo, run_id: Number(runId), filter: 'all', per_page: 100 }));
  if (sourceJobs.get(runId).some(job => job.id === run.id && job.run_id === Number(runId) && job.name === run.name && job.head_sha === sha)) trustedRuns.push(run);
}
for (const name of required) {
  const latest = trustedRuns.filter(run => run.name === name).sort((a, b) => b.id - a.id)[0];
  if (!latest || latest.head_sha !== sha || latest.app?.id !== 15368 || latest.status !== 'completed' || latest.conclusion !== 'success') deny(`check not successful from GitHub Actions: ${name}`);
}
core.info(`Promotion allowed actor=${context.actor} sha=${sha} staging=${staging} checks=${required.join(',')}`);
};
