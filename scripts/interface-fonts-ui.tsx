import { useState } from 'react';
import { applyInterfaceTextSize } from '../src/renderer/lib/interface-typography';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DesktopLeftSidebar } from '../src/renderer/shells/desktop/DesktopLeftSidebar';
import { DesktopRightSidebar } from '../src/renderer/shells/desktop/DesktopRightSidebar';
import { DesktopBottomTimeline } from '../src/renderer/shells/desktop/views/DesktopBottomTimeline';
import { BrushIcon } from '../src/renderer/components/ui/BrushIcon';
import { Sidebar } from '../src/renderer/components/Sidebar';
import { WorkspaceSidebarToggles } from '../src/renderer/components/workspaceChrome/WindowControlButtons';
import { WorkspaceNavigationProvider } from '../src/renderer/features/workspace/navigation/WorkspaceNavigationContext';
import { SuperViewRelationUiProvider } from '../src/renderer/features/graph/SuperViewRelationUiContext';
import { useDataStore } from '../src/renderer/store/data-store';
import { useUiStore } from '../src/renderer/store/ui-store';
import { useAuthStore } from '../src/renderer/store/auth';
import { getPlatformRuntime } from '../src/renderer/platform/runtime';
import { singleSidebarTab } from '../src/renderer/lib/sidebar-tabs';
import { createSyntheticWorkspaceProjection } from '../src/renderer/performance/fixture';
import { deriveNodeStorylineState } from '../src/renderer/domain/node-storyline-state';
import { createPlainCommentDoc } from '../src/renderer/domain/comment';
import { seedChapterTitle, SEED_STORYLINES } from '../src/renderer/services/sample-project/scenario';
import { setI18nLocale } from '../src/renderer/lib/i18n';
import '@fontsource-variable/inter-tight';
import '../src/styles/index.css';
import '../src/styles/materials.css';
import '../src/styles/comments-review.css';
import '../src/styles/entity-editors.css';
import '../src/styles/material-workbench.css';
import '../src/styles/desktop-shell.css';
import '../src/styles/ui-controls.css';
import '../src/styles/settings.css';
import '../src/styles/agent-activity.css';
import '../src/styles/desktop-typography.css';
import '../src/styles/interface-fonts.css';
const options=new URLSearchParams(location.search);
const leftPanel=options.get('left')==='elements'?'elements':'nodes';
const projectId='typography-hierarchy-synthetic';
const at='2026-10-29T00:00:00.000Z';
const fixture=createSyntheticWorkspaceProjection(projectId,18,18);
fixture.bookNodes=fixture.bookNodes.map((node,i)=>({...node,title:i===1?'北岬 · North Cape':seedChapterTitle(i),bookOrder:i*5,narrativeOrder:i*5,wordCount:i===1?51:394,updatedAt:at,createdAt:at}));
fixture.storylines=SEED_STORYLINES.map((name,i)=>({id:'story-'+i,projectId,name:i===2?'潮汐档案 · Tides':name,color:'#a59075',summary:'合成故事线',orderKey:i,folderId:null,taskTodos:true,contentJson:'{}',kvJson:'[]',nodeContentTemplateJson:'{}',createdAt:at,updatedAt:at}));
Object.assign(fixture,deriveNodeStorylineState(fixture.bookNodes.map((node,i)=>({nodeId:node.id,storylineId:'story-'+(i<3?0:i%3),isPrimary:true}))));
const notes=['阅读批注 40：明确场景的空间关系。参考灯塔的未寄出的信。','阅读批注 39：回收先前的伏笔。参考白沙湾的未寄出的信。','修订任务 39：回收先前的伏笔。参考白沙湾的未寄出的信。','阅读批注 38：减少解释性对白。参考防波堤的未寄出的信。','修订任务 38：减少解释性对白。参考防波堤的未寄出的信。','阅读批注 36：核对潮位和出航时间。参考修船厂的旧海图。'];
fixture.comments=notes.map((text,i)=>({id:'review-'+i,projectId,kind:i===2||i===4?'todo':'note',targetKind:'node',targetId:fixture.bookNodes[[14,12,12,10,10,8][i]].id,targetBlockId:null,anchorJson:'{}',authorKind:'user',authorId:null,authorName:null,bodyJson:createPlainCommentDoc(text),status:'open',priority:null,source:'manual',metadataJson:null,targetBlockIdsJson:'[]',resolvedAt:null,createdAt:new Date(Date.parse(at)-i*1000).toISOString(),updatedAt:new Date(Date.parse(at)-i*1000).toISOString()}));
const categoryBase=fixture.bookElementCategories[0];
fixture.bookElementCategories=[
 {...categoryBase,id:'cast',name:'人物 · Cast',color:'#a59075'},
 {...categoryBase,id:'places',name:'地点 · Places',color:'#a59075'},
 {...categoryBase,id:'objects',name:'物件 · Objects',color:'#a59075'},
];
const entityRows=[
 ['林潮','cast','调查组 / CORE'],['许知遥','cast','调查组 / CORE'],['周牧','cast','调查组 / CORE'],
 ['老船长','cast','岛民 / LOCAL'],['沈阿婆','cast','岛民 / LOCAL'],['灯塔看守人','cast','岛民 / LOCAL'],
 ['林父','cast',null],['医生 · Dr. Reed','cast',null],
 ['北岬','places','海岸 / COAST'],['旧码头','places','海岸 / COAST'],['白沙湾','places','海岸 / COAST'],
 ['档案室','places','镇上 / TOWN'],['修船厂','places','镇上 / TOWN'],
 ['旧海图','objects','线索 / CLUES'],['缺页日志','objects','线索 / CLUES'],['未寄出的信','objects','线索 / CLUES'],
 ['黄铜钥匙','objects','随身 / CARRY'],['航海手表','objects','随身 / CARRY'],
];
fixture.bookElements=entityRows.map(([name,categoryId,groupName],i)=>({...fixture.bookElements[i],name,categoryId,groupName,aliases:[],summary:'合成字体预览条目'}));
const store=useDataStore.getState();const epoch=store.requestWorkspaceProjection(projectId,'loading');store.commitWorkspaceProjection(projectId,epoch,fixture);
useAuthStore.setState({isAuthenticated:true,user:{id:'local',name:'本地',email:''} as never});
useUiStore.setState({sidebars:{left:{isOpen:true,width:280},right:{isOpen:true,width:300}},desktopSidebarTabs:{left:{...singleSidebarTab(leftPanel),keepSingle:true},right:{...singleSidebarTab('review'),keepSingle:true}},activeLeftPanel:leftPanel,activeRightPanel:'review',rightPanelGroup:'content',reviewScope:'project',chapterPanelViewMode:'storyline',elementPanelViewMode:'compact',bottomTimelineHidden:false,nodeUi:{selectedId:'synthetic-node-1',selectedFrom:'ui',selectedAt:null,activeStorylineId:'story-0'}});
useUiStore.getState().openEntityTab(projectId,{entityType:'node',id:'synthetic-node-1'});
Object.assign(getPlatformRuntime(),{isMacDesktop:true,isMobileShell:false,desktopWindowControls:false,shellMode:'desktop'});
setI18nLocale('zh-CN');
const root=document.documentElement;root.dataset.shellMode='desktop';root.dataset.interfaceTextSize='standard';root.dataset.colorScheme='light';root.classList.remove('dark');root.style.colorScheme='light';
root.style.setProperty('--editor-font-family','var(--font-prose-system-serif)');root.style.setProperty('--editor-font-size','17px');root.style.setProperty('--editor-line-height','1.5');root.style.setProperty('--editor-max-width','720px');root.style.setProperty('--editor-paragraph-spacing','17px');
const navigator={projectId,open(){},activate(){},showProjectHome(){},leaveDeletedTarget(){}};
const styles=document.createElement('style');styles.textContent=`html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}.preview-traffic{position:fixed;top:13px;left:18px;display:flex;gap:9px;z-index:50}.preview-traffic i{height:14px;width:14px;border-radius:50%;background:#ff6058;border:1px solid #e84942}.preview-traffic i:nth-child(2){background:#ffbd2e;border-color:#e9a91b}.preview-traffic i:nth-child(3){background:#28c840;border-color:#1bac2b}.preview-editor-tools{position:absolute;bottom:18px;right:18px;display:flex;gap:18px;padding:9px 14px;border:1px solid #e7e5e4;border-radius:24px;background:#fff;color:#777;font:16px sans-serif}.preview-editor-tools span{font-size:18px}.page{box-sizing:border-box}.desktop-sidebar-panel-host{min-height:0}`;document.head.appendChild(styles);
export function Fixture(){return <WorkspaceNavigationProvider navigator={navigator}><SuperViewRelationUiProvider projectId={projectId}><div className="app-root desktop-app-shell"><div className="app-row desktop-workspace-row"><Sidebar sidebarType="left"><DesktopLeftSidebar/></Sidebar><main className="app-mid desktop-workspace-main"><div className="workspace-stage desktop-workspace-stage editor-shell"><div className="editor-scroll" style={{height:'100%'}}><div className="editor__spread"><article className="page"><div className="page__folio"><span>章节</span><span className="page__folio-line page__folio-line--accent">灯塔的秘密</span><span className="page__folio-line">51 字</span></div><h1 className="page__title">北岬 · North Cape</h1><div className="page__sub">第2次调查：林潮在旧码头核对缺页日志，归岛阶段出现新的时间差。</div><hr className="page__rule"/><div className="page__body"><div className="ProseMirror"><p>退潮后的礁石露出水面，像一条通往灯塔的路。</p><p>老船长坐在灯塔基座上补网，看见她的时候一点也不意外。“你还是回来了。”他说。</p></div></div></article></div></div><div className="preview-editor-tools">{(['plan-go','toc-raked','knot-links','comment','more'] as const).map(name=><BrushIcon key={name} name={name} size={18}/>)}</div></div><div style={{height:180,flexShrink:0,overflow:'hidden'}}><DesktopBottomTimeline/></div></main><Sidebar sidebarType="right"><div className="desktop-sidebar-panel-host"><DesktopRightSidebar/></div></Sidebar></div><WorkspaceSidebarToggles/></div><FontAcceptanceControls/><div className="preview-traffic" aria-label="浏览器组件预览"><i/><i/><i/></div></SuperViewRelationUiProvider></WorkspaceNavigationProvider>}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={['/project/'+projectId+'/editor/synthetic-node-1']}><Routes><Route path="/project/:projectId/editor/:nodeId" element={<Fixture/>}/></Routes></MemoryRouter></QueryClientProvider>);



export function FontAcceptanceControls() {
 const [report,setReport]=useState<Awaited<ReturnType<typeof measureInterfaceFonts>> | null>(null);
 if(options.has('capture')) return null;
 return <aside style={{position:'fixed',bottom:8,left:8,zIndex:1000,background:'white',padding:8,maxHeight:160,overflow:'auto',maxWidth:360}}>
  <button onClick={()=>void measureInterfaceFonts().then(setReport)}>Run font role checks</button>
  <output id="interface-font-result" style={{display:'block',whiteSpace:'pre-wrap'}}>{report?JSON.stringify(report):'Not run'}</output>
 </aside>;
}

async function measureInterfaceFonts() {
 const root=document.documentElement;
 const fontFaces=await Promise.all([
  ['Newsreader Variable','Review Agent North Cape'],
  ['Noto Serif SC Variable','章节要素构想素材库灯塔的秘密人物地点'],
  ['Source Sans 3 Variable','North Cape Dr. Reed'],
  ['Noto Sans SC Variable','北岬林潮阅读批注'],
  ['Sarasa Mono SC','主角人物分类0123456789TODO'],
 ].map(async([family,text])=>{
  const faces=await document.fonts.load(`400 14px "${family}"`,text);
  return {family,loaded:faces.length>0 && faces.every(face=>face.status==='loaded')};
 }));
 const snapshot=(selector:string)=>{
  const styles=new Map<string,{text:string | null,fontFamily:string,fontSize:string,lineHeight:string,fontStyle:string,letterSpacing:string,count:number}>();
  for(const node of document.querySelectorAll<HTMLElement>(selector)) {
   const style=getComputedStyle(node);
   const metrics={fontFamily:style.fontFamily,fontSize:style.fontSize,lineHeight:style.lineHeight,fontStyle:style.fontStyle,letterSpacing:style.letterSpacing};
   const key=JSON.stringify(metrics);
   const previous=styles.get(key);
   if(previous) previous.count+=1;
   else styles.set(key,{text:node.textContent,...metrics,count:1});
  }
  return [...styles.values()];
 };
 const prose=snapshot('.page__body .ProseMirror')[0];
 const samples=[];
 const settle=()=>new Promise<void>(resolve=>setTimeout(resolve,80));
 for(const locale of ['zh-CN','en'] as const) for(const theme of ['light','dark']) for(const size of ['small','standard','large'] as const) for(const panel of ['nodes','elements'] as const) {
  setI18nLocale(locale);root.classList.toggle('dark',theme==='dark');applyInterfaceTextSize(size);
  useUiStore.setState({desktopSidebarTabs:{...useUiStore.getState().desktopSidebarTabs,left:{...singleSidebarTab(panel),keepSingle:true}},activeLeftPanel:panel});
  await settle();await document.fonts.ready;
  const roles={
   tabs:snapshot('.workspace-panel-tab-row [data-panel-tab-label]'),
   structure:snapshot('.left-sb-group-header__name,.btl-rail__name'),
   subheader:snapshot('.left-panel-view-mode-text'),
   groups:snapshot('.left-sb-inline-group-header'),
   filters:snapshot('.review-panel__type-filters button'),
   entities:snapshot('.sand-cell:not(.left-sb-group-header),.element-panel-item-label,.review-group__name'),
   review:snapshot('.review-card__body'),
  };
  const has=(items:typeof roles.tabs,family:string)=>items.length>0 && items.every(item=>item.fontFamily.includes(family));
  const probes=['000000000000','主角人物分类'].map(text=>{
   const span=document.createElement('span');span.textContent=text;span.style.cssText='position:absolute;visibility:hidden;font:14px var(--font-mono);white-space:pre';document.body.append(span);const width=span.getBoundingClientRect().width;span.remove();return width;
  });
  const checks={
   tabs:has(roles.tabs,'Newsreader Variable'),
   structure:has(roles.structure,'Noto Serif SC Variable') && roles.structure.every(item=>item.fontStyle==='normal'),
   subheader:has(roles.subheader,'Sarasa Mono SC'),
   groups:panel==='nodes' || has(roles.groups,'Sarasa Mono SC'),
   filters:has(roles.filters,'Sarasa Mono SC'),
   entities:has(roles.entities,'Noto Sans SC Variable'),
   review:has(roles.review,'Source Sans 3 Variable'),
   prose:JSON.stringify(snapshot('.page__body .ProseMirror')[0])===JSON.stringify(prose),
   bilingualMono:Math.abs(probes[0]-probes[1])<0.2,
  };
  samples.push({locale,theme,size,panel,roles,checks,monoAdvances:probes});
 }
 root.dataset.shellMode='mobile';
 const mobileFallback=getComputedStyle(document.body).fontFamily.includes('Inter Tight');
 root.dataset.shellMode='desktop';root.classList.remove('dark');applyInterfaceTextSize('standard');setI18nLocale('zh-CN');
 useUiStore.setState({desktopSidebarTabs:{...useUiStore.getState().desktopSidebarTabs,left:{...singleSidebarTab('nodes'),keepSingle:true}},activeLeftPanel:'nodes'});
 return {status:fontFaces.every(face=>face.loaded) && samples.every(sample=>Object.values(sample.checks).every(Boolean)) && mobileFallback?'passed':'failed',viewport:[innerWidth,innerHeight],fontFaces,prose,mobileFallback,samples};
}
