const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const sha = 'a'.repeat(40);
const {createHash}=require('node:crypto');
const policyPath='.github/promotion-policy.json';
const policyDigest=names=>createHash('sha256').update(JSON.stringify([...new Set(names)].sort())).digest('hex');
async function gate(overrides = {}) {
  const env = {PROMOTION_SHA:sha, PROMOTION_ACTOR:'console[bot]', REQUIRED_CHECKS:'["CI"]', STAGING_ENV:'staging', TRIGGERING_ACTOR:'console[bot]', ...overrides.env};
  const context = {repo:{owner:'org',repo:'app'}, eventName:'workflow_dispatch', ref:'refs/heads/main', actor:'console[bot]', payload:{inputs:{tier:'production'}}, ...overrides.context};
  const calls = []; calls.outputs={}; calls.policyReads=[];
  const github = {rest:{actions:{getWorkflowRun:async({run_id})=>({data:{event:run_id === 11 ? 'workflow_dispatch' : 'push',head_branch:'main',head_sha:sha}})},repos:{compareCommitsWithBasehead:async()=>({data:{status:'ahead'}}),listDeployments:async()=>({data:[{id:1,sha,ref:sha,creator:{login:'github-actions[bot]'}}]}),listDeploymentStatuses:async()=>({data:[{state:'success',creator:{login:'github-actions[bot]'}}]})},checks:{listForRef:async()=>({data:{check_runs:overrides.checks || [{id:2,name:'CI',head_sha:sha,details_url:'https://github.com/org/app/actions/runs/10/job/20',status:'completed',conclusion:'success',app:{id:15368}}]}})}}};
  for (const run of overrides.checks || []) run.details_url ??= 'https://github.com/org/app/actions/runs/10/job/20';
  if(overrides.workflowRun) github.rest.actions.getWorkflowRun = async()=>({data:overrides.workflowRun});
  github.rest.repos.getBranch=async()=>({data:{commit:{sha:overrides.mainCommit || 'b'.repeat(40)}}});
  github.rest.repos.getContent=async args=>{calls.policyReads.push(args);const text=overrides.policyText ?? JSON.stringify(overrides.policy ?? {version:1,additionalRequiredChecks:['Integration']});return {data:{type:'file',path:policyPath,sha:'c'.repeat(40),encoding:'base64',size:Buffer.byteLength(text),content:Buffer.from(text).toString('base64'),...overrides.policyResponse}};};
  if(overrides.api) Object.assign(github.rest.repos, overrides.api);
  const sourceRun=run=>Number(run.details_url?.match(/\/actions\/runs\/(\d+)/)?.[1]);
  github.rest.actions.listJobsForWorkflowRun=async args=>{(calls.jobReads??=[]).push(args);return {data:{jobs:overrides.jobs ?? (await github.rest.checks.listForRef()).data.check_runs.filter(run=>sourceRun(run)===args.run_id).map(run=>({id:run.id,run_id:args.run_id,name:run.name,head_sha:sha}))}};};
  if(overrides.actionsApi) Object.assign(github.rest.actions, overrides.actionsApi);
  github.paginate = async (method, args) => {const r=await method(args); return r.data.check_runs || r.data.jobs || r.data;};
  const core={info:m=>calls.push(m),setOutput:(name,value)=>{calls.outputs[name]=value;}};
  const verifier=process.env.PROMOTION_GATE_ENGINE==='baseline' ? require('./fixtures/promotion-gate-baseline.cjs') : require('../.github/actions/verify-promotion/verifier.cjs');
  await verifier({github,context,core,env});
  return calls;
}
test('permits a trusted console promotion of validated main source', async()=>assert.ok((await gate()).some(m=>m.includes(sha))));
for(const [name,overrides] of Object.entries({
  'human rerun':{env:{TRIGGERING_ACTOR:'human'}},
  'non-push CI':{workflowRun:{event:'workflow_dispatch',head_branch:'main',head_sha:sha}},
  'non-main CI':{workflowRun:{event:'push',head_branch:'feature',head_sha:sha}},
  'empty actor':{env:{PROMOTION_ACTOR:''}}, 'empty SHA':{env:{PROMOTION_SHA:''}},
  'short SHA':{env:{PROMOTION_SHA:'abcdef'}}, 'uppercase SHA':{env:{PROMOTION_SHA:'A'.repeat(40)}},
  'empty checks':{env:{REQUIRED_CHECKS:'[]'}}, 'malformed checks':{env:{REQUIRED_CHECKS:'null'}},
  'empty staging':{env:{STAGING_ENV:''}}, 'untrusted actor':{context:{actor:'human'}},
  'push event':{context:{eventName:'push'}}, 'non-main dispatch':{context:{ref:'refs/heads/prod'}},
  'wrong tier':{context:{payload:{inputs:{tier:'staging'}}}},
  'source outside main':{api:{compareCommitsWithBasehead:async()=>({data:{status:'diverged'}})}},
  'missing staging':{api:{listDeployments:async()=>({data:[]})}},
  'failed staging':{api:{listDeploymentStatuses:async()=>({data:[{state:'failure',creator:{login:'github-actions[bot]'}}]})}},
  'forged staging':{api:{listDeployments:async()=>({data:[{id:1,sha,ref:sha,creator:{login:'human'}}]})}},
  'wrong staging sha':{api:{listDeployments:async()=>({data:[{id:1,sha:'b'.repeat(40),creator:{login:'github-actions[bot]'}}]})}},
  'missing CI':{checks:[]},
  'forged CI':{checks:[{id:1,name:'CI',head_sha:sha,status:'completed',conclusion:'success',app:{id:999}}]},
  'newest CI failed':{checks:[{id:1,name:'CI',head_sha:sha,status:'completed',conclusion:'success',app:{id:15368}},{id:2,name:'CI',head_sha:sha,details_url:'https://github.com/org/app/actions/runs/10/job/20',status:'completed',conclusion:'failure',app:{id:15368}}]},
  'CI wrong sha':{checks:[{id:1,name:'CI',head_sha:'b'.repeat(40),status:'completed',conclusion:'success',app:{id:15368}}]},
})) test(`denies ${name}`,async()=>assert.rejects(()=>gate(overrides), /Promotion denied:/));

test('ignores dispatch validation while requiring newest main push validation', async()=> {
  await gate({checks:[
    {id:1,name:'CI',head_sha:sha,status:'completed',conclusion:'success',app:{id:15368}},
    {id:3,name:'CI',head_sha:sha,status:'in_progress',app:{id:15368},details_url:'https://github.com/org/app/actions/runs/11/job/30'},
  ]});
});
test('preserves ordinary workflow calls without promotion configuration', async()=> {
  await gate({env:{PROMOTION_SHA:'',PROMOTION_ACTOR:'',REQUIRED_CHECKS:''},context:{eventName:'pull_request',actor:'developer',ref:'refs/pull/1/merge'}});
});

test('permits a successful staged SHA after GitHub marks it inactive', async()=> {
  await gate({api:{listDeploymentStatuses:async()=>({data:[{state:'inactive',creator:{login:'github-actions[bot]'}},{state:'success',creator:{login:'github-actions[bot]'}}]})}});
});
test('does not mask failed staging behind inactive or older success', async()=> {
  await assert.rejects(()=>gate({api:{listDeploymentStatuses:async()=>({data:[{state:'inactive',creator:{login:'github-actions[bot]'}},{state:'failure',creator:{login:'github-actions[bot]'}},{state:'success',creator:{login:'github-actions[bot]'}}]})}}), /Promotion denied:/);
});

test('denies branch-ref staging records even when resolved SHA matches', async()=> {
  await assert.rejects(()=>gate({api:{listDeployments:async()=>({data:[{id:1,sha,ref:'main',creator:{login:'github-actions[bot]'}}]})}}), /Promotion denied:/);
});
function jobField(job, field) {
  const yaml = fs.readFileSync('.github/workflows/sst-deploy.yml', 'utf8');
  const block = yaml.match(new RegExp(`^  ${job}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|$(?![\\s\\S]))`, 'm'))[1];
  return block.match(new RegExp(`^    ${field}: (.*)$`, 'm'))?.[1];
}
function condition(job, inputs, needs, github, cancelled = false) {
  const expression = jobField(job, 'if')?.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  assert.ok(expression, `${job} must have an explicit condition`);
  return new Function('inputs', 'needs', 'github', 'cancelled', 'format', 'always', `return ${expression.replace(/needs\.([a-z]+(?:-[a-z]+)+)/g, "needs['$1']")}`)({policy_path:'',policy_digest:'',...inputs}, needs, github, ()=>cancelled, (_pattern,value)=>`refs/heads/${value}`, ()=>true);
}
test('legacy calls skip gate runner and retain validation then staging and production', ()=> {
  const inputs={promotion_sha:'',promotion_actor:'',promotion_required_checks:'',prod_branch:'main',staging:true};
  const needs={'promotion-gate':{result:'skipped',outputs:{}},validate:{result:'success',outputs:{promotion_enabled:''}}};
  const github={event_name:'push',ref:'refs/heads/main'};
  assert.equal(condition('promotion-gate', inputs, needs, github), false);
  assert.equal(condition('validate', inputs, needs, github), true);
  for(const job of ['deploy-staging','deploy-production']) {
    assert.equal(jobField(job,'needs'), 'validate');
    assert.equal(condition(job, inputs, needs, github), true);
  }
  assert.equal(jobField('preview-deploy','needs'),'validate');
});
test('failed promotion gate blocks validation and has no direct deployment bypass', ()=> {
  const inputs={promotion_sha:sha,promotion_actor:'console[bot]',promotion_required_checks:'["CI"]'};
  const needs={'promotion-gate':{result:'failure',outputs:{enabled:'true'}}};
  assert.equal(condition('promotion-gate',inputs,needs,{}), true);
  assert.equal(condition('validate',inputs,needs,{event_name:'workflow_dispatch'}), false);
  for(const job of ['deploy-staging','deploy-production','preview-deploy']) assert.equal(jobField(job,'needs'),'validate');
});

test('legacy PR previews keep validation and preview deploy enabled', ()=> {
  const inputs={promotion_sha:'',promotion_actor:'',promotion_required_checks:'',previews:true};
  const needs={'promotion-gate':{result:'skipped',outputs:{}},validate:{result:'success',outputs:{promotion_enabled:''}}};
  const github={event_name:'pull_request',event:{pull_request:{user:{login:'developer'}}}};
  assert.equal(condition('promotion-gate',inputs,needs,github),false);
  assert.equal(condition('validate',inputs,needs,github),true);
  assert.equal(condition('preview-deploy',inputs,needs,github),true);
  assert.equal(condition('validate',inputs,needs,github,true),false);
  github.event.pull_request.user.login='dependabot[bot]';
  assert.equal(condition('validate',inputs,needs,github),false);
});

test('deploy jobs explicitly handle skipped gate ancestors and reject failed validation', ()=> {
  const inputs={promotion_sha:'',promotion_actor:'',promotion_required_checks:'',prod_branch:'main',previews:true};
  for(const job of ['deploy-staging','deploy-production','preview-deploy']) {
    assert.match(jobField(job,'if'), /!cancelled\(\)/);
    const needs={validate:{result:'failure',outputs:{promotion_enabled:''}}};
    assert.equal(condition(job,inputs,needs,{event_name:'push',ref:'refs/heads/main'}),false);
  }
});

const policyEnv={POLICY_PATH:policyPath,POLICY_DIGEST:policyDigest(['CI','Integration'])};
const successCheck=name=>({id:name==='CI'?2:3,name,head_sha:sha,status:'completed',conclusion:'success',app:{id:15368}});
test('repository additions cannot be skipped and are read from immutable trusted main',async()=>{
 await assert.rejects(()=>gate({env:policyEnv}),/Promotion denied:/);
 const result=await gate({env:policyEnv,checks:[successCheck('CI'),successCheck('Integration')]});
 assert.deepEqual(result.policyReads,[{owner:'org',repo:'app',path:policyPath,ref:'b'.repeat(40)}]);
 assert.equal(result.outputs.policy_digest,policyDigest(['CI','Integration']));
 assert.equal(result.outputs.policy_source_commit,'b'.repeat(40));
 assert.equal(result.outputs.policy_blob_sha,'c'.repeat(40));
});
for(const [name,overrides] of Object.entries({
 'path without digest':{env:{POLICY_PATH:policyPath}},
 'digest without path':{env:{POLICY_DIGEST:policyEnv.POLICY_DIGEST}},
 'wrong digest':{env:{...policyEnv,POLICY_DIGEST:'d'.repeat(64)}},
 'uppercase digest':{env:{...policyEnv,POLICY_DIGEST:'D'.repeat(64)}},
 'traversal path':{env:{...policyEnv,POLICY_PATH:'.github/../policy.json'}},
 'git metadata path':{env:{...policyEnv,POLICY_PATH:'.git/policy.json'}},
 'missing policy':{api:{getContent:async()=>{throw new Error('404');}}},
 'non-file policy':{policyResponse:{type:'dir'}},
 'unsupported policy':{policy:{version:2,additionalRequiredChecks:[]}},
 'unknown policy keys':{policy:{version:1,additionalRequiredChecks:[],force:true}},
 'missing additions':{policy:{version:1}},
 'blank addition':{policy:{version:1,additionalRequiredChecks:['']}},
 'untrimmed addition':{policy:{version:1,additionalRequiredChecks:[' CI']}},
 'too many additions':{policy:{version:1,additionalRequiredChecks:Array.from({length:33},(_,i)=>`Check${i}`)}},
 'too long addition':{policy:{version:1,additionalRequiredChecks:['x'.repeat(161)]}},
 'oversized document':{policyText:' '.repeat(16385)},
 'non-UTF8 policy':{policyResponse:{content:Buffer.from([255]).toString('base64'),size:1}},
})) test(`policy denies ${name}`,async()=>assert.rejects(()=>gate({env:policyEnv,...overrides}),/Promotion denied:/));
test('empty and duplicate additions preserve baseline without creating extra requirements',async()=>{
 await gate({env:{POLICY_PATH:policyPath,POLICY_DIGEST:policyDigest(['CI'])},policy:{version:1,additionalRequiredChecks:[]}});
 await gate({env:{POLICY_PATH:policyPath,POLICY_DIGEST:policyDigest(['CI'])},policy:{version:1,additionalRequiredChecks:['CI','CI']}});
});
test('preproduction verification independently denies changed requirements and accepts semantic-equivalent policy',async()=>{
 const options={phase:'production',env:policyEnv,checks:[successCheck('CI'),successCheck('Integration')]};
 await gate({...options,policyText:'{ "additionalRequiredChecks": ["Integration","CI"], "version":1 }'});
 await assert.rejects(()=>gate({...options,policy:{version:1,additionalRequiredChecks:['New gate']}}),/Promotion denied:/);
 await assert.rejects(()=>gate({...options,checks:[successCheck('CI'),{...successCheck('Integration'),conclusion:'failure'}]}),/Promotion denied:/);
});
test('policy-only configuration schedules fail-closed gate instead of ordinary production',()=>{
 assert.equal(condition('promotion-gate',{policy_path:policyPath,policy_digest:'',promotion_sha:'',promotion_actor:'',promotion_required_checks:''},{},{}),true);
});

test('revalidation preserves the exact verification logic and happens before AWS credentials and hooks',()=>{
 const source=fs.readFileSync('.github/workflows/sst-deploy.yml','utf8');
 const production=source.split('  deploy-production:')[1].split('  preview-deploy:')[0];
 const step=production.split('      - name: Revalidate promotion policy before credentials\n')[1];
 assert.match(step,/uses: Bike4Mind\/workflow-templates\/\.github\/actions\/verify-promotion@7149a9499c9f7a860fd517c31a972a89bcd5a14b/);
 assert.ok(production.indexOf('run: pnpm install --frozen-lockfile') < production.indexOf('Revalidate promotion policy'));
 assert.ok(production.indexOf('Revalidate promotion policy') < production.indexOf('aws-actions/configure-aws-credentials'));
 assert.ok(production.indexOf('aws-actions/configure-aws-credentials') < production.indexOf('- name: Pre-deploy'));
 assert.match(step,/if: inputs.policy_path != '' \|\| inputs.policy_digest != ''/);
 assert.match(production,/if: \(failure\(\) \|\| cancelled\(\)\) && .*steps.policy_recheck.outcome == 'success'/);
 assert.match(production,/      checks: read/);
 assert.match(production,/      actions: read/);
});
test('unrelated main advance and policy blob edits preserve effective approval digest',async()=>{
 const result=await gate({phase:'production',env:policyEnv,checks:[successCheck('CI'),successCheck('Integration')],mainCommit:'d'.repeat(40),policyResponse:{sha:'e'.repeat(40)}});
 assert.equal(result.outputs.policy_source_commit,'d'.repeat(40));
 assert.equal(result.outputs.policy_blob_sha,'e'.repeat(40));
 assert.equal(result.outputs.policy_digest,policyEnv.POLICY_DIGEST);
});
for(const path of ['/policy.json','policy.json/','a//policy.json','a/./policy.json','a/../policy.json','a/.git/policy.json','a%2Fpolicy.json','a\\policy.json','a/policy.JSON','x'.repeat(241)+'.json']) {
 test(`denies unsafe policy path ${JSON.stringify(path).slice(0,50)}`,async()=>assert.rejects(()=>gate({env:{...policyEnv,POLICY_PATH:path}}),/Promotion denied:/));
}
for(const policy of [null,[],true,1,'text',{version:1,additionalRequiredChecks:['CI\nInjection']},{version:1,additionalRequiredChecks:['CI\u007f']}]) {
 test(`denies invalid policy shape ${JSON.stringify(policy)}`,async()=>assert.rejects(()=>gate({env:policyEnv,policyText:JSON.stringify(policy)}),/Promotion denied:/));
}
test('repository additions cannot replace missing baseline or erase baseline CI',async()=>{
 await assert.rejects(()=>gate({env:{...policyEnv,REQUIRED_CHECKS:'[]'},policy:{version:1,additionalRequiredChecks:['Integration']},checks:[successCheck('Integration')]}),/Promotion denied:/);
 await assert.rejects(()=>gate({env:policyEnv,checks:[successCheck('Integration')]}),/Promotion denied:/);
});
test('policy denial skips unlock while later opted-in deployment failure still unlocks',()=>{
 const source=fs.readFileSync('.github/workflows/sst-deploy.yml','utf8').split('  deploy-production:')[1];
 const expression=source.split('      - name: Unlock SST state on failure\n')[1].match(/        if: (.*)/)[1];
 const evaluate=(path,result,failed)=>new Function('inputs','steps','failure','cancelled',`return ${expression}`)({policy_path:path,policy_digest:path?'a'.repeat(64):''},{policy_entry:{outcome:result},policy_recheck:{outcome:result}},()=>failed,()=>false);
 assert.equal(evaluate('','skipped',true),true);
 assert.equal(evaluate(policyPath,'failure',true),false);
 assert.equal(evaluate(policyPath,'success',true),true);
 assert.equal(evaluate(policyPath,'success',false),false);
});

test('queued policy drift is checked before any production checkout, package code or deployment mutation',()=>{
 const source=fs.readFileSync('.github/workflows/sst-deploy.yml','utf8');
 const production=source.split('  deploy-production:')[1].split('  preview-deploy:')[0];
 const steps=production.split('    steps:\n')[1];
 assert.ok(steps.startsWith('      - name: Verify queued promotion before checkout\n'));
 assert.ok(steps.indexOf('verify-promotion@7149a9499c9f7a860fd517c31a972a89bcd5a14b') < steps.indexOf('Start promotion deployment record'));
 assert.ok(steps.indexOf('Verify queued promotion before checkout') < steps.indexOf('actions/checkout@'));
 assert.ok(steps.indexOf('Verify queued promotion before checkout') < steps.indexOf('pnpm install'));
 const expression=production.split('      - name: Unlock SST state on failure\n')[1].match(/        if: (.*)/)[1];
 const unlock=(entry,final)=>new Function('inputs','steps','failure','cancelled',`return ${expression}`)({policy_path:policyPath,policy_digest:'a'.repeat(64)},{policy_entry:{outcome:entry},policy_recheck:{outcome:final}},()=>true,()=>false);
 assert.equal(unlock('failure','skipped'),false);
 assert.equal(unlock('success','failure'),false);
 assert.equal(unlock('success','success'),true);
});


test('extracted verifier preserves the frozen pre-extraction gate exactly',()=>{
 const baseline=fs.readFileSync('tests/fixtures/promotion-gate-baseline.cjs','utf8');
 const extracted=fs.readFileSync('.github/actions/verify-promotion/verifier.cjs','utf8');
 assert.equal(extracted,baseline);
});
test('composite action loads trusted action source and derives context internally',()=>{
 const action=fs.readFileSync('.github/actions/verify-promotion/action.yml','utf8');
 const inputs=action.split('inputs:\n')[1].split('outputs:\n')[0];
 assert.deepEqual([...inputs.matchAll(/^  ([a-z_]+):$/gm)].map(m=>m[1]),['promotion_sha','promotion_actor','promotion_required_checks','staging_env','policy_path','policy_digest']);
 assert.match(action,/VERIFIER_PATH: \$\{\{ github.action_path \}\}\/verifier.cjs/);
 assert.match(action,/TRIGGERING_ACTOR: \$\{\{ github.triggering_actor \}\}/);
 assert.match(action,/github-token: \$\{\{ github.token \}\}/);
 assert.match(action,/await require\(process.env.VERIFIER_PATH\)\(\{github, context, core\}\);/);
 assert.doesNotMatch(action,/checkout@|github.workspace|working-directory:/);
 for(const [name,input] of Object.entries({PROMOTION_SHA:'promotion_sha',PROMOTION_ACTOR:'promotion_actor',REQUIRED_CHECKS:'promotion_required_checks',STAGING_ENV:'staging_env',POLICY_PATH:'policy_path',POLICY_DIGEST:'policy_digest'})) assert.ok(action.includes(`${name}: \${{ inputs.${input} }}`));
 for(const output of ['enabled','policy_digest','policy_source_commit','policy_blob_sha']) assert.ok(action.includes(`value: \${{ steps.verify.outputs.${output} }}`));
});
test('API refusal fails closed',async()=>{
 await assert.rejects(()=>gate({api:{compareCommitsWithBasehead:async()=>{throw new Error('API unavailable');}}}),/API unavailable/);
});

test('verification reports enabled accurately without treating empty configuration as promotion',async()=>{
 assert.equal((await gate()).outputs.enabled,'true');
 const skipped=await gate({env:{PROMOTION_SHA:'',PROMOTION_ACTOR:'',REQUIRED_CHECKS:''}});
 assert.deepEqual(skipped.outputs,{enabled:'false'});
});

test('all three verifier boundaries use the reviewed immutable action and exact six inputs',()=>{
 const yaml=fs.readFileSync('.github/workflows/sst-deploy.yml','utf8');
 const pin='Bike4Mind/workflow-templates/.github/actions/verify-promotion@7149a9499c9f7a860fd517c31a972a89bcd5a14b';
 assert.equal(yaml.split(`uses: ${pin}`).length-1,3);
 assert.ok(yaml.includes('enabled: ${{ steps.gate.outputs.enabled }}'));
 assert.ok(yaml.includes('promotion_enabled: ${{ needs.promotion-gate.outputs.enabled }}'));
 for(const [name,id] of [['Verify source, actor and validation evidence','gate'],['Verify queued promotion before checkout','policy_entry'],['Revalidate promotion policy before credentials','policy_recheck']]) {
   const step=yaml.split(`      - name: ${name}\n`)[1].split(/\n      - |\n  [a-z]/)[0];
   assert.ok(step.includes(`uses: ${pin}`));
   assert.ok(step.includes(`id: ${id}\n`));
   assert.doesNotMatch(step,/^        (script|env|github-token):/m);
   const forwarded=[...step.matchAll(/^          ([a-z_]+): \$\{\{ inputs\.([a-z_]+) \}\}$/gm)].map(m=>[m[1],m[2]]);
   assert.deepEqual(forwarded,['promotion_sha','promotion_actor','promotion_required_checks','staging_env','policy_path','policy_digest'].map(name=>[name,name]));
 }
});

test('staging toggle and promotion interact fail-closed',()=>{
  const base={promotion_sha:'',promotion_actor:'',promotion_required_checks:'',prod_branch:'main'};
  const push={event_name:'push',ref:'refs/heads/main'};
  const ok={validate:{result:'success',outputs:{promotion_enabled:''}}};
  const promoted={validate:{result:'success',outputs:{promotion_enabled:'true'}}};
  assert.equal(condition('deploy-staging',{...base,staging:false},ok,push),false);
  assert.equal(condition('deploy-production',{...base,staging:false},ok,push),true);
  assert.equal(condition('deploy-staging',{...base,staging:true},promoted,{event_name:'workflow_dispatch',ref:'refs/heads/main'}),false);
  assert.equal(condition('deploy-production',{...base,staging:false},promoted,{event_name:'workflow_dispatch',ref:'refs/heads/main'}),true);
});
test('target-only inputs survive: runner labels and working directory',()=>{
  const yaml=fs.readFileSync('.github/workflows/sst-deploy.yml','utf8');
  assert.equal(jobField('validate','runs-on'),'${{ inputs.validate_runner }}');
  for(const job of ['deploy-staging','deploy-production','preview-deploy']) assert.equal(jobField(job,'runs-on'),'${{ inputs.deploy_runner }}');
  assert.equal(jobField('promotion-gate','runs-on'),'ubuntu-latest');
  assert.ok(yaml.split('working-directory: ${{ inputs.working_directory }}').length-1>=4);
});

test('ancestry check receives the resolved main commit and never the bare branch name',async()=>{
 const bases=[];
 await gate({mainCommit:'e'.repeat(40),api:{compareCommitsWithBasehead:async a=>{bases.push(a.basehead);return {data:{status:'identical'}};}}});
 assert.deepEqual(bases,[`${sha}...${'e'.repeat(40)}`]);
 assert.ok(bases.every(b=>!/\.\.\.main$/.test(b)));
});
for(const [name,overrides] of Object.entries({
 'getBranch failure':{api:{getBranch:async()=>{throw new Error('500');}}},
 'malformed SHA':{mainCommit:'MAIN'},
 'short SHA':{mainCommit:'b'.repeat(39)},
 'missing commit':{api:{getBranch:async()=>({data:{}})}},
})) test(`denies a promotion without a policy on ${name}`,async()=>assert.rejects(()=>gate(overrides),/Promotion denied: trusted main commit unavailable/));
test('policy promotion resolves main once and reads the policy at that commit',async()=>{
 let branchCalls=0;
 const result=await gate({env:policyEnv,mainCommit:'f'.repeat(40),checks:[successCheck('CI'),successCheck('Integration')],api:{getBranch:async()=>{branchCalls++;return {data:{commit:{sha:'f'.repeat(40)}}};}}});
 assert.equal(branchCalls,1);
 assert.equal(result.policyReads[0].ref,'f'.repeat(40));
 assert.equal(result.outputs.policy_source_commit,'f'.repeat(40));
});
test('production entry verification covers every promotion input and blocks unlock when it fails',()=>{
 const source=fs.readFileSync('.github/workflows/sst-deploy.yml','utf8');
 const production=source.split('  deploy-production:')[1].split('  preview-deploy:')[0];
 const entry=production.split('      - name: Verify queued promotion before checkout\n')[1].split('\n      - ')[0];
 const expression=entry.match(/        if: (.*)/)[1];
 const none={promotion_sha:'',promotion_actor:'',promotion_required_checks:'',policy_path:'',policy_digest:''};
 const run=inputs=>new Function('inputs',`return ${expression}`)({...none,...inputs});
 assert.equal(run({}),false);
 for(const key of Object.keys(none)) assert.equal(run({[key]:'x'}),true);
 assert.equal(run({promotion_sha:sha,promotion_actor:'console[bot]',promotion_required_checks:'["CI"]'}),true);
 assert.match(production.split('      - name: Unlock SST state on failure\n')[1].match(/        if: (.*)/)[1],/^\(failure\(\) \|\| cancelled\(\)\) && steps\.policy_entry\.outcome != 'failure' && /);
});
test('promotion without a policy skips unlock when entry verification failed',()=>{
 const production=fs.readFileSync('.github/workflows/sst-deploy.yml','utf8').split('  deploy-production:')[1];
 const expression=production.split('      - name: Unlock SST state on failure\n')[1].match(/        if: (.*)/)[1];
 const unlock=entry=>new Function('inputs','steps','failure','cancelled',`return ${expression}`)({policy_path:'',policy_digest:''},{policy_entry:{outcome:entry},policy_recheck:{outcome:'skipped'}},()=>true,()=>false);
 assert.equal(unlock('failure'),false);
 assert.equal(unlock('success'),true);
 assert.equal(unlock('skipped'),true);
});

const jobCheck=(id,conclusion='success',extra={})=>({id,name:'CI',head_sha:sha,status:'completed',conclusion,app:{id:15368},...extra});
const jobOf=(id,extra={})=>({id,run_id:10,name:'CI',head_sha:sha,...extra});
const notSuccessful=/Promotion denied: check not successful from GitHub Actions: CI/;
test('a check that only names a main push run is not evidence without a job of that run',async()=>{
 await assert.rejects(()=>gate({checks:[jobCheck(99)],jobs:[]}),notSuccessful);
 await assert.rejects(()=>gate({checks:[jobCheck(99)],jobs:[jobOf(2)]}),notSuccessful);
});
test('a newer check outside the run job list cannot replace the result of the real job',async()=>{
 await assert.rejects(()=>gate({checks:[jobCheck(2,'failure'),jobCheck(99)],jobs:[jobOf(2)]}),notSuccessful);
 assert.ok((await gate({checks:[jobCheck(2),jobCheck(99,'failure')],jobs:[jobOf(2)]})).some(m=>m.includes('Promotion allowed')));
});
for(const [name,job] of Object.entries({
 'another name':jobOf(2,{name:'Lint'}),
 'another run':jobOf(2,{run_id:12}),
 'another commit':jobOf(2,{head_sha:'d'.repeat(40)}),
 'a string id':jobOf('2'),
})) test(`denies a check whose matching job has ${name}`,async()=>assert.rejects(()=>gate({checks:[jobCheck(2)],jobs:[job]}),notSuccessful));
test('job lists are read once per main push run, across every attempt, and never for other sources',async()=>{
 const twice=await gate({env:{REQUIRED_CHECKS:'["CI","Integration"]'},checks:[jobCheck(2),jobCheck(3,'success',{name:'Integration'})]});
 assert.deepEqual(twice.jobReads,[{owner:'org',repo:'app',run_id:10,filter:'all',per_page:100}]);
 const mixed=await gate({checks:[jobCheck(2),jobCheck(5,'failure',{details_url:'https://github.com/org/app/actions/runs/11/job/5'})]});
 assert.deepEqual(mixed.jobReads.map(read=>read.run_id),[10]);
});
test('a failed job list read fails closed',async()=>assert.rejects(()=>gate({actionsApi:{listJobsForWorkflowRun:async()=>{throw new Error('500');}}}),/500/));
