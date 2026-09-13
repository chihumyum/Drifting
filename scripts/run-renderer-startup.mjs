import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startupRepetitions, summarizeStartupRuns, validateStartupReport, validateStartupFailure } from './renderer-startup-contract.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const sourcePaths = ['src', 'src-tauri', 'drizzle', 'packages', 'patches', 'vite-plugins', 'vite.renderer.config.ts', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'index.html', 'tailwind.config.js', 'postcss.config.js'];
const harnessFiles = ['scripts/run-renderer-startup.mjs', 'scripts/renderer-startup-ui.ts', 'scripts/renderer-startup-contract.mjs', 'scripts/renderer-native-fixture.ts', 'scripts/renderer-native-db.ts'];
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fingerprint = () => hash([...new Set([...git('ls-files', '-z', '--', ...sourcePaths).split('\0').filter(Boolean), ...harnessFiles])].sort().map(file => `${file}\0${hash(readFileSync(path.join(root,file)))}`).join('\n'));
const output = path.resolve(root,process.argv.find(arg=>arg.startsWith('--report='))?.slice(9) ?? 'docs/renderer-performance/acceptance/f0-native-startup.json');
const failureOutput = path.join(path.dirname(output), `${path.parse(output).name}.failed.json`);
if(process.argv.includes('--check-failure')) {
  const report=JSON.parse(readFileSync(failureOutput,'utf8'));validateStartupFailure(report);
  if(!process.argv.includes('--historical')) assert.equal(report.source.fingerprint,fingerprint(),'Failed attempt source or collector changed.');
  console.log(process.argv.includes('--historical') ? 'Historical failed startup record validates; current source was not asserted.' : 'Failed startup attempt matches current source; it is not passing startup evidence.');process.exit(0);
}
if(process.argv.includes('--check')) {
  const report=JSON.parse(readFileSync(output,'utf8'));validateStartupReport(report);
  assert.equal(report.source.fingerprint,fingerprint(),'Native startup source or collector changed.');
  console.log('Repeated native startup evidence is current; fixed M1/8GB and signed RC gates remain open.');process.exit(0);
}
assert.equal(process.platform,'darwin');
assert.equal(git('ls-files','--others','--exclude-standard','--',...sourcePaths),'','Stage audited new product source before snapshotting.');
const temporary=realpathSync(mkdtempSync(path.join(os.tmpdir(),'drifting-startup-acceptance-')));
const source=path.join(temporary,'source');const runId=randomBytes(6).toString('hex');
const identifier=`cc.drifting.client.startup.r${runId}`;const productName=`Drifting Startup ${runId}`;const token=randomBytes(32).toString('hex');
const env=Object.fromEntries(['PATH','HOME','USER','TMPDIR','CARGO_HOME','RUSTUP_HOME','DEVELOPER_DIR','SDKROOT','LANG'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
Object.assign(env,{VITE_LOCAL_ONLY_MODE:'true',VITE_REQUIRE_AUTH:'false',VITE_AI_TRANSPORT:'direct',VITE_API_BASE_URL:'http://localhost:3000',API_BASE_URL:'http://localhost:3000',CARGO_TARGET_DIR:process.env.CARGO_TARGET_DIR ?? path.join(root,'src-tauri/target')});
const run=(cmd,args,cwd=source)=>new Promise((resolve,reject)=>{const child=spawn(cmd,args,{cwd,env,stdio:'inherit'});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`${cmd} exited ${code}`)));});
let worktree=false;let server;let launcher;let nativePid;let completed=false;let result;
const nativeProcesses = () => execFileSync('ps',['-axo','pid=,command='],{encoding:'utf8'}).split('\n').map(line=>line.trim().match(/^(\d+)\s+(.+)$/)).filter(Boolean);
try {
  assert(!nativeProcesses().some(row=>/\/Drifting[^/]*\.app\/Contents\/MacOS\//.test(row[2])),'Close any running Drifting app before this attended measurement.');
  const commit=git('rev-parse','HEAD');const sourceFingerprint=fingerprint();
  console.log(`Owned startup workspace: ${temporary}`);
  execFileSync('git',['-C',root,'worktree','add','--detach',source,commit],{stdio:'pipe'});worktree=true;
  const patch=execFileSync('git',['-C',root,'diff','--binary','HEAD','--',...sourcePaths]);
  if(patch.length)execFileSync('git',['-C',source,'apply','-'],{input:patch});
  symlinkSync(path.join(root,'node_modules'),path.join(source,'node_modules'),'dir');
  for(const file of harnessFiles)cpSync(path.join(root,file),path.join(source,file));
  const fixtureDir=path.join(temporary,'fixture');const reproducedDir=path.join(temporary,'reproduced');
  for(const directory of [fixtureDir,reproducedDir]) await run(process.execPath,['--conditions=import','--import=tsx','scripts/renderer-native-fixture.ts',directory,'--startup']);
  const fixture=JSON.parse(readFileSync(path.join(fixtureDir,'fixture.json'),'utf8'));
  assert.deepEqual(JSON.parse(readFileSync(path.join(reproducedDir,'fixture.json'),'utf8')),fixture);
  const inspect=file=>JSON.parse(execFileSync(process.execPath,['--conditions=import','--import=tsx','--input-type=module','-e','const mod = await import("./scripts/renderer-native-db.ts"); console.log(JSON.stringify((mod.default ?? mod).inspectNativeFixture(process.argv[1])))',file],{cwd:source,env,encoding:'utf8'}));
  const before=inspect(path.join(fixtureDir,'drifting-library.db'));
  server=createServer(async(request,response)=>{
    const origin=request.headers.origin;
    if(!['tauri://localhost','http://tauri.localhost','https://tauri.localhost'].includes(origin)){response.writeHead(403).end();return;}
    response.setHeader('Access-Control-Allow-Origin',origin);response.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');response.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
    if(request.url!=='/report'){response.writeHead(404).end();return;}
    if(request.method==='OPTIONS'){response.writeHead(204).end();return;}
    if(request.method!=='POST'||request.headers.authorization!==`Bearer ${token}`){response.writeHead(403).end();return;}
    try{let body='';for await(const part of request){body+=part;assert(body.length<32768);}assert.equal(result,null,'Duplicate startup result');result=JSON.parse(body);response.writeHead(204).end();}
    catch{response.writeHead(400).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const endpoint=`http://127.0.0.1:${server.address().port}/report`;
  const secureFile=path.join(source,'src-tauri/src/secure_storage.rs');const secure=readFileSync(secureFile,'utf8');const anchor='const KEYCHAIN_SERVICE: &str = "Drifting";';
  assert.equal(secure.split(anchor).length,2);writeFileSync(secureFile,secure.replace(anchor,`const KEYCHAIN_SERVICE: &str = "Drifting.Startup.${runId}";`));
  // Read-only diagnostics belong to this isolated acceptance build only.
  const capabilityFile=path.join(source,'src-tauri/capabilities/desktop.json');
  const capability=JSON.parse(readFileSync(capabilityFile,'utf8'));
  capability.permissions.push('core:window:allow-is-focused','core:window:allow-is-visible');
  writeFileSync(capabilityFile,JSON.stringify(capability));
  const base=JSON.parse(readFileSync(path.join(source,'src-tauri/tauri.conf.json'),'utf8'));
  writeFileSync(path.join(source,'src-tauri/tauri.startup.conf.json'),JSON.stringify({productName,identifier,
    build:{beforeBuildCommand:'pnpm exec vite build --config vite.renderer-startup.config.ts'},
    app:{security:{csp:base.app.security.csp.replace("connect-src 'self'",`connect-src 'self' http://127.0.0.1:${server.address().port}`)}},
    bundle:{createUpdaterArtifacts:false},plugins:{'deep-link':{desktop:{schemes:[`drifting-startup-${runId}`]}}}}));
  writeFileSync(path.join(source,'vite.renderer-startup.config.ts'),`
import { mergeConfig } from 'vite';
import base from './vite.renderer.config';
export default env => mergeConfig(base(env), {
 define: { __DRIFTING_STARTUP_CONFIG__: ${JSON.stringify(JSON.stringify({endpoint,token,projectId:fixture.projects[0].id,nodeIds:fixture.projects[0].nodeIds}))} },
 plugins: [{ name: 'startup-observation-only', enforce: 'pre', transform(code,id) {
  const mark = name => 'globalThis.__DRIFTING_STARTUP_MARK__(' + JSON.stringify(name) + ');';
  const replace = (anchor, replacement) => { if(code.split(anchor).length!==2) throw new Error('Startup trace anchor drifted: '+anchor);code=code.replace(anchor,replacement); };
  if(id.endsWith('/src/renderer/main.tsx')) {
    replace('async function bootstrap() {','async function bootstrap() { '+mark('bootstrap-start'));
    replace('await Promise.all([hydrateSessionToken(), hydratePlatformRuntime()]);','await Promise.all([hydrateSessionToken(), hydratePlatformRuntime()]); '+mark('metadata-ready'));
    replace("createRoot(document.getElementById('root')!).render(",mark('react-mount-requested')+" createRoot(document.getElementById('root')!).render(");
    return 'import "../../scripts/renderer-startup-ui";\\n'+code;
  }
  if(id.endsWith('/app/providers/ProjectRuntimeProvider.tsx')) {
    replace('const capture = await captureWorkspaceProjection({ projectId, userId });',mark('projection-capture-start')+' const capture = await captureWorkspaceProjection({ projectId, userId }); '+mark('projection-capture-ready'));
    return code;
  }
 } }],
});
`);
  const buildStarted=Date.now();
  await run('pnpm',['exec','tauri','build','--bundles','app','--no-sign','--config','src-tauri/tauri.startup.conf.json']);
  const bundle=path.join(env.CARGO_TARGET_DIR,'release/bundle/macos',`${productName}.app`);const plist=path.join(bundle,'Contents/Info.plist');
  const value=key=>execFileSync('/usr/libexec/PlistBuddy',['-c',`Print :${key}`,plist],{encoding:'utf8'}).trim();
  assert.equal(value('CFBundleIdentifier'),identifier);const binary=path.join(bundle,'Contents/MacOS',value('CFBundleExecutable'));
  assert(statSync(binary).mtimeMs>=buildStarted,'Refusing a stale native build');
  const artifact={bundleName:path.basename(bundle),identifier,version:value('CFBundleShortVersionString'),sha256:hash(readFileSync(binary)),modifiedAt:statSync(binary).mtime.toISOString(),build:'packaged-release-production-renderer',signed:false};
  console.log(`Verified release artifact: ${binary} (${artifact.sha256})`);
  const runs=[];
  for(let index=0;index<startupRepetitions;index++){
    assert.equal(fingerprint(),sourceFingerprint,'Source changed during measurement');
    const dbDir=path.join(temporary,`run-${index}`);mkdirSync(dbDir);const databaseFile=path.join(dbDir,'drifting-library.db');cpSync(path.join(fixtureDir,'drifting-library.db'),databaseFile);
    // Let macOS complete the prior application's focus/termination transition.
    // This fixed quiet interval is outside the measured launch boundary.
    await delay(1500);
    result=null;nativePid=null;const launchRequestedAt=Date.now();
    launcher=spawn('/usr/bin/open',['-n','-W',bundle,'--env',`DRIFTING_DB_DIR=${dbDir}`,'--stdout',path.join(temporary,`run-${index}.stdout.log`),'--stderr',path.join(temporary,`run-${index}.stderr.log`)],{env,stdio:'inherit'});
    let launchError;launcher.once('error',error=>{launchError=error;});
    for(let n=0;n<1800&&!result;n++){
      assert(!launchError, String(launchError));
      nativePid ??= Number(nativeProcesses().find(row=>row[2]===binary)?.[1])||null;
      assert.equal(launcher.exitCode,null,'Launcher ended before startup report');await delay(50);
    }
    assert(result,'No startup report; inspect owned native logs.');
    if(result.status!=='passed') {
      const failed={schemaVersion:1,kind:'renderer_native_startup_failure',status:'failed',generatedAt:new Date().toISOString(),
        source:{commit,fingerprint:sourceFingerprint,trackedProductChanges:patch.length>0},artifact,
        environment:{platform:os.platform(),architecture:os.arch(),osRelease:os.release(),cpu:os.cpus()[0].model,totalMemoryBytes:os.totalmem()},
        fixture:{specification:fixture.specification,semanticSha256:fixture.semanticSha256,reproducible:true,freshCopyPerLaunch:true},
        attemptIndex:index,completedSamples:runs.length,measurementStatus:'incomplete',shutdown:'not-accepted',failure:result};
      validateStartupFailure(failed);assert.equal(fingerprint(),sourceFingerprint);
      writeFileSync(failureOutput,JSON.stringify(failed,null,2)+'\n');
      console.error(`Failed startup report (not passing evidence): ${failureOutput}`);
    }
    assert.equal(result.status,'passed',JSON.stringify(result));assert(nativePid,'Native process identity was not observed');
    const getMark=name=>{const found=result.marks.filter(m=>m.name===name);assert.equal(found.length,1,name);return found[0].atMs;};
    const metrics={launchToShelfMs:result.timeOrigin+result.shelfReadyMs-launchRequestedAt,projectOpenMs:result.projectReadyMs-result.projectRequestedMs,
      first50kOpenMs:result.editorTrials[0].readyMs-result.editorTrials[0].requestedMs,small5kOpenMs:result.editorTrials[1].readyMs-result.editorTrials[1].requestedMs,
      bootstrapMs:getMark('metadata-ready')-getMark('bootstrap-start'),projectionCaptureMs:getMark('projection-capture-ready')-getMark('projection-capture-start')};
    console.log(`Startup sample ${index+1}/${startupRepetitions} measured: ${JSON.stringify(metrics)}`);
    console.log(`Awaiting native Quit: ${productName}. Use its Quit menu or Cmd+Q now.`);
    for(let n=0;n<1200&&launcher.exitCode===null;n++)await delay(100);
    assert.equal(launcher.exitCode,0,'Normal Quit must release the LaunchServices wait handle');
    assert(!nativeProcesses().some(row=>Number(row[1])===nativePid),'Measured native process is still running');
    const after=inspect(databaseFile);assert.deepEqual(after.chapters,before.chapters,'Timing probes changed canonical prose');
    runs.push({...result,index,launchRequestedAt,metrics,launcherExitCode:launcher.exitCode,nativeProcessExited:true,nativeExitCode:null,
      proseUnchanged:true,unchangedChapters:after.chapters.length,integrityCheck:'ok',foreignKeyCheck:'ok'});
    nativePid=null;launcher=null;
  }
  const report={schemaVersion:1,kind:'renderer_native_startup',status:'passed',generatedAt:new Date().toISOString(),
    source:{commit,fingerprint:sourceFingerprint,trackedProductChanges:patch.length>0},artifact,
    environment:{platform:os.platform(),architecture:os.arch(),osRelease:os.release(),cpu:os.cpus()[0].model,totalMemoryBytes:os.totalmem()},
    fixture:{specification:fixture.specification,semanticSha256:fixture.semanticSha256,reproducible:true,freshCopyPerLaunch:true},
    warmupRuns:1,interLaunchDelayMs:1500,runs,summary:summarizeStartupRuns(runs),
    acceptance:{fixedM1Budget:'not-run',coldFilesystem:'not-controlled',physicalIme:'not-run',signedRc:'not-run'},
    limitations:[
      'Unsigned Release Tauri binary with production Vite renderer, lightweight acceptance-only marks and product singleton imports. This is a baseline on the reported host, not a signed RC or fixed M1/8GB qualification.',
      'Launch begins at the open -n -W request, includes LaunchServices and window activation, and ends at an enabled shelf action after fonts and two animation frames. Epoch clocks are from the same host; five millisecond polling and frame observation add measurement overhead.',
      'One first launch is retained separately; summary uses five subsequent fresh processes with warmed OS/WebKit disk caches. Filesystem caches are not flushed. Each process receives the same fresh SQLite fixture copy and empty in-memory tabs; local app storage/keychain and compiled caches may be warmed.',
      'Project time uses the actual shelf card click. The first 50k and subsequent 5k chapter use product tab/navigation commands. Editable focused canonical Yjs, exact text length, loaded fonts and two frames form the ready condition. No synthetic typing or physical input latency is measured.',
      'Normal native Cmd+Q is attended; LaunchServices wrapper exit zero and disappearance of the exact native PID are verified. Native process exit code is unavailable because LaunchServices owns it. Independent read-only SQLite/Yjs replay verifies all 53 chapter hashes after each exit.',
      'Five samples give a nearest-rank p95 equal to the maximum; this is not a statistically stable tail estimate. No startup improvement, regression budget, memory reclamation or device matrix completion is inferred from this single-build baseline.',
    ]};
  validateStartupReport(report);assert.equal(fingerprint(),sourceFingerprint);writeFileSync(output,JSON.stringify(report,null,2)+'\n');completed=true;
  console.log(`Repeated native startup report: ${output}`);
} finally {
  if(nativePid&&nativeProcesses().some(row=>Number(row[1])===nativePid)){process.kill(nativePid,'SIGTERM');await delay(1000);}
  if(launcher?.exitCode===null)launcher.kill('SIGTERM');
  if(server)await new Promise(resolve=>server.close(resolve));
  if(worktree)execFileSync('git',['-C',root,'worktree','remove','--force',source],{stdio:'pipe'});
  if(completed)rmSync(temporary,{recursive:true,force:true});else console.error(`Failed startup artifacts retained: ${temporary}`);
}
