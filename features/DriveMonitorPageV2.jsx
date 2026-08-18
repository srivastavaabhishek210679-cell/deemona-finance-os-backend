import { useState, useEffect } from 'react';
import { apiURL } from '../../api.js';

const h = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token') ?? ''}` });
const get  = async url => { try { const r = await fetch(apiURL(url), { headers: h() }); return await r.json(); } catch { return {}; } };
const post = async (url, body) => { try { const r = await fetch(apiURL(url), { method: 'POST', headers: h(), body: JSON.stringify(body) }); return await r.json(); } catch (e) { return { error: e.message }; } };
const patch = async url => { try { const r = await fetch(apiURL(url), { method: 'PATCH', headers: h() }); return await r.json(); } catch (e) { return { error: e.message }; } };
const del  = async url => { try { const r = await fetch(apiURL(url), { method: 'DELETE', headers: h() }); return await r.json(); } catch { return {}; } };

export default function DriveMonitorPage() {
  const [status, setStatus] = useState(null);
  const [settings, setSettings] = useState({ folder_id:'', folder_name:'', google_api_key:'', recipients:'', check_interval_seconds:60, file_types:['monthly','weekly','daily'], enabled:false });
  const [processed, setProcessed] = useState([]);
  const [logs, setLogs] = useState([]);
  const [tab, setTab] = useState('setup');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [saveResult, setSaveResult] = useState(null);
  const [toggling, setToggling] = useState(false);

  const load = async () => {
    const [s, st, p, l] = await Promise.all([
      get('/api/monitor/settings'),
      get('/api/monitor/status'),
      get('/api/monitor/processed'),
      get('/api/monitor/logs'),
    ]);
    if (s.settings) {
      setSettings({
        folder_id: s.settings.folder_id || '',
        folder_name: s.settings.folder_name || '',
        google_api_key: s.settings.google_api_key || '',
        recipients: (s.settings.recipients || []).join(', '),
        check_interval_seconds: s.settings.check_interval_seconds || 60,
        file_types: s.settings.file_types || ['monthly','weekly','daily'],
        enabled: s.settings.enabled || false,
      });
    }
    setStatus(st);
    setProcessed(p.files || []);
    setLogs(l.logs || []);
  };

  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, []);

  const save = async () => {
    setSaving(true); setSaveResult(null);
    const recipients = settings.recipients.split(',').map(r => r.trim()).filter(Boolean);
    const res = await post('/api/monitor/settings', { ...settings, recipients });
    setSaveResult(res);
    setSaving(false);
    if (!res.error) load();
  };

  const test = async () => {
    setTesting(true); setTestResult(null);
    const res = await post('/api/monitor/test', {});
    setTestResult(res);
    setTesting(false);
  };

  const toggle = async () => {
    setToggling(true);
    const res = await patch('/api/monitor/settings/toggle');
    if (!res.error) load();
    setToggling(false);
  };

  const reprocess = async (id) => { await del(`/api/monitor/processed/${id}`); load(); };

  const toggleFileType = (type) => {
    setSettings(prev => ({
      ...prev,
      file_types: prev.file_types.includes(type)
        ? prev.file_types.filter(t => t !== type)
        : [...prev.file_types, type]
    }));
  };

  const FILE_TYPE_COLORS = { monthly:'#1B4FD8', weekly:'#059669', daily:'#D97706' };

  return (
    <div style={{padding:24,background:'#EEF3FD',minHeight:'100%'}}>
      {/* Header */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:24}}>
        <div>
          <h1 style={{fontSize:20,fontWeight:800,color:'#0A1628',marginBottom:4}}>Drive Monitor</h1>
          <div style={{fontSize:13,color:'#64748B'}}>Autonomous Google Drive financial file monitoring — configure your own folder and recipients.</div>
        </div>
        <div style={{display:'flex',gap:10,alignItems:'center'}}>
          <div style={{padding:'8px 14px',borderRadius:8,background:status?.active?'#ECFDF5':'#FEF2F2',border:`1px solid ${status?.active?'#A7F3D0':'#FECACA'}`,display:'flex',alignItems:'center',gap:8}}>
            <div style={{width:8,height:8,borderRadius:'50%',background:status?.active?'#059669':'#DC2626'}} />
            <span style={{fontSize:12,fontWeight:600,color:status?.active?'#059669':'#DC2626'}}>
              {status?.active ? 'Monitor Active' : 'Monitor Inactive'}
            </span>
          </div>
          {status?.configured && (
            <button onClick={toggle} disabled={toggling} style={{padding:'8px 18px',borderRadius:8,border:'none',background:status?.active?'#DC2626':'#059669',color:'#fff',fontSize:12,fontWeight:700,cursor:'pointer'}}>
              {toggling ? '...' : status?.active ? 'Stop Monitor' : 'Start Monitor'}
            </button>
          )}
        </div>
      </div>

      {/* Stats */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:14,marginBottom:20}}>
        {[
          {label:'Files Processed',  value:status?.files_processed||0,    color:'#1B4FD8', icon:'📁'},
          {label:'Last Checked',     value:status?.last_checked?new Date(status.last_checked).toLocaleTimeString('en-IN'):'Never', color:'#7C3AED', icon:'⏱'},
          {label:'Check Interval',   value:`${status?.sleep_seconds||60}s`, color:'#059669', icon:'🔄'},
          {label:'Recipients',       value:status?.recipients?.length||0,  color:'#D97706', icon:'📧'},
        ].map((s,i) => (
          <div key={i} style={{padding:'14px 16px',borderRadius:10,background:'#fff',border:'1px solid #C7D9F8'}}>
            <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}>
              <div style={{fontSize:11,color:'#64748B',fontWeight:600}}>{s.label}</div>
              <span>{s.icon}</span>
            </div>
            <div style={{fontSize:18,fontWeight:800,color:s.color}}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{display:'flex',borderBottom:'1px solid #C7D9F8',marginBottom:20}}>
        {[['setup','⚙️ Setup'],['processed','📁 Processed Files'],['logs','📋 Activity Log'],['how','❓ How It Works']].map(([id,label]) => (
          <button key={id} onClick={() => setTab(id)} style={{padding:'10px 18px',fontSize:13,fontWeight:600,background:'none',border:'none',borderBottom:tab===id?'2px solid #1B4FD8':'2px solid transparent',color:tab===id?'#1B4FD8':'#64748B',cursor:'pointer',marginBottom:-1}}>{label}</button>
        ))}
      </div>

      {/* Setup tab */}
      {tab === 'setup' && (
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:20}}>
          <div>
            {/* Google Drive Config */}
            <div style={{background:'#fff',borderRadius:12,border:'1px solid #C7D9F8',padding:20,marginBottom:16}}>
              <div style={{fontSize:13,fontWeight:700,color:'#0A1628',marginBottom:4}}>Google Drive Configuration</div>
              <div style={{fontSize:12,color:'#64748B',marginBottom:16}}>Connect your own Google Drive folder to monitor.</div>

              <div style={{marginBottom:14}}>
                <label style={{display:'block',fontSize:12,fontWeight:600,color:'#334155',marginBottom:5}}>Google Drive Folder ID <span style={{color:'#DC2626'}}>*</span></label>
                <input value={settings.folder_id} onChange={e => setSettings(p => ({...p, folder_id: e.target.value}))}
                  placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs"
                  style={{width:'100%',boxSizing:'border-box',padding:'9px 12px',borderRadius:8,border:'1px solid #C7D9F8',fontSize:13,outline:'none',fontFamily:'monospace'}} />
                <div style={{fontSize:11,color:'#64748B',marginTop:3}}>From Drive URL: drive.google.com/drive/folders/<strong>THIS_PART</strong></div>
              </div>

              <div style={{marginBottom:14}}>
                <label style={{display:'block',fontSize:12,fontWeight:600,color:'#334155',marginBottom:5}}>Folder Name (optional)</label>
                <input value={settings.folder_name} onChange={e => setSettings(p => ({...p, folder_name: e.target.value}))}
                  placeholder="Finance Reports 2026"
                  style={{width:'100%',boxSizing:'border-box',padding:'9px 12px',borderRadius:8,border:'1px solid #C7D9F8',fontSize:13,outline:'none',fontFamily:'inherit'}} />
              </div>

              <div style={{marginBottom:14}}>
                <label style={{display:'block',fontSize:12,fontWeight:600,color:'#334155',marginBottom:5}}>Google Drive API Key <span style={{color:'#DC2626'}}>*</span></label>
                <input value={settings.google_api_key} onChange={e => setSettings(p => ({...p, google_api_key: e.target.value}))}
                  placeholder="AIzaSy..."
                  type="password"
                  style={{width:'100%',boxSizing:'border-box',padding:'9px 12px',borderRadius:8,border:'1px solid #C7D9F8',fontSize:13,outline:'none',fontFamily:'monospace'}} />
                <div style={{fontSize:11,color:'#64748B',marginTop:3}}>Get free API key at <a href="https://console.cloud.google.com" target="_blank" rel="noreferrer" style={{color:'#1B4FD8'}}>console.cloud.google.com</a> → Enable Drive API → Credentials</div>
              </div>

              <div style={{padding:'10px 14px',borderRadius:8,background:'#FFFBEB',border:'1px solid #FDE68A',fontSize:12,color:'#92400E',marginBottom:14}}>
                Make sure your Drive folder is shared: <strong>Right-click folder → Share → Anyone with the link → Viewer</strong>
              </div>

              <button onClick={test} disabled={testing || !settings.folder_id || !settings.google_api_key}
                style={{width:'100%',padding:'9px',borderRadius:8,border:'1px solid #C7D9F8',background:'#F0F5FF',color:'#1B4FD8',fontSize:13,fontWeight:600,cursor:'pointer',marginBottom:8}}>
                {testing ? 'Testing connection...' : '🔍 Test Drive Connection'}
              </button>

              {testResult && (
                <div style={{padding:'10px 12px',borderRadius:8,background:testResult.success?'#ECFDF5':'#FEF2F2',border:`1px solid ${testResult.success?'#A7F3D0':'#FECACA'}`,fontSize:12,color:testResult.success?'#059669':'#DC2626'}}>
                  {testResult.success
                    ? `✅ Connected! ${testResult.files_found} files visible in folder.${testResult.files?.map(f => '\n• ' + f.name).join('') || ''}`
                    : `❌ Error: ${testResult.error}`}
                </div>
              )}
            </div>

            {/* Recipients */}
            <div style={{background:'#fff',borderRadius:12,border:'1px solid #C7D9F8',padding:20,marginBottom:16}}>
              <div style={{fontSize:13,fontWeight:700,color:'#0A1628',marginBottom:4}}>Report Recipients</div>
              <div style={{fontSize:12,color:'#64748B',marginBottom:12}}>Who should receive the FOS&A report emails?</div>
              <textarea value={settings.recipients} onChange={e => setSettings(p => ({...p, recipients: e.target.value}))}
                placeholder="cfo@company.com, finance@company.com, md@company.com"
                rows={3}
                style={{width:'100%',boxSizing:'border-box',padding:'9px 12px',borderRadius:8,border:'1px solid #C7D9F8',fontSize:13,outline:'none',fontFamily:'inherit',resize:'vertical'}} />
              <div style={{fontSize:11,color:'#64748B',marginTop:3}}>Separate multiple emails with commas</div>
            </div>

            {/* File types and interval */}
            <div style={{background:'#fff',borderRadius:12,border:'1px solid #C7D9F8',padding:20,marginBottom:16}}>
              <div style={{fontSize:13,fontWeight:700,color:'#0A1628',marginBottom:12}}>Monitor Settings</div>

              <div style={{marginBottom:14}}>
                <label style={{display:'block',fontSize:12,fontWeight:600,color:'#334155',marginBottom:8}}>Detect File Types</label>
                <div style={{display:'flex',gap:10}}>
                  {['monthly','weekly','daily'].map(type => (
                    <button key={type} onClick={() => toggleFileType(type)}
                      style={{padding:'7px 16px',borderRadius:8,border:`2px solid ${settings.file_types.includes(type)?FILE_TYPE_COLORS[type]:'#E2E8F0'}`,background:settings.file_types.includes(type)?FILE_TYPE_COLORS[type]+'15':'#F8FAFC',color:settings.file_types.includes(type)?FILE_TYPE_COLORS[type]:'#334155',fontSize:12,fontWeight:600,cursor:'pointer',textTransform:'capitalize'}}>
                      {settings.file_types.includes(type) ? '✓ ' : ''}{type}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label style={{display:'block',fontSize:12,fontWeight:600,color:'#334155',marginBottom:5}}>Check Interval (seconds)</label>
                <select value={settings.check_interval_seconds} onChange={e => setSettings(p => ({...p, check_interval_seconds: parseInt(e.target.value)}))}
                  style={{width:'100%',padding:'9px 12px',borderRadius:8,border:'1px solid #C7D9F8',fontSize:13,outline:'none',background:'#fff'}}>
                  <option value={30}>Every 30 seconds</option>
                  <option value={60}>Every 60 seconds</option>
                  <option value={300}>Every 5 minutes</option>
                  <option value={600}>Every 10 minutes</option>
                  <option value={1800}>Every 30 minutes</option>
                  <option value={3600}>Every hour</option>
                </select>
              </div>
            </div>

            {/* Save */}
            <button onClick={save} disabled={saving}
              style={{width:'100%',padding:'12px',borderRadius:9,border:'none',background:saving?'#93B4EF':'#1B4FD8',color:'#fff',fontSize:14,fontWeight:700,cursor:'pointer',marginBottom:10}}>
              {saving ? 'Saving...' : '💾 Save Monitor Settings'}
            </button>

            {saveResult && (
              <div style={{padding:'10px 14px',borderRadius:8,background:saveResult.error?'#FEF2F2':'#ECFDF5',border:`1px solid ${saveResult.error?'#FECACA':'#A7F3D0'}`,fontSize:13,color:saveResult.error?'#DC2626':'#059669',fontWeight:600}}>
                {saveResult.error ? '❌ ' + saveResult.error : '✅ ' + saveResult.message}
              </div>
            )}
          </div>

          {/* Right: Status & Info */}
          <div>
            {/* Current Status */}
            <div style={{background:'#fff',borderRadius:12,border:'1px solid #C7D9F8',padding:20,marginBottom:16}}>
              <div style={{fontSize:13,fontWeight:700,color:'#0A1628',marginBottom:14}}>Monitor Status</div>
              {[
                {label:'Status',        value:status?.active?'Active':'Inactive',          color:status?.active?'#059669':'#DC2626'},
                {label:'Configured',    value:status?.configured?'Yes':'No',               color:status?.configured?'#059669':'#DC2626'},
                {label:'Folder',        value:status?.folder_name||status?.folder_id||'Not set', color:'#334155'},
                {label:'Recipients',    value:status?.recipients?.join(', ')||'None',      color:'#334155'},
                {label:'Interval',      value:`Every ${status?.sleep_seconds||60}s`,       color:'#334155'},
                {label:'Files Processed', value:String(status?.files_processed||0),        color:'#1B4FD8'},
                {label:'Last Checked',  value:status?.last_checked?new Date(status.last_checked).toLocaleString('en-IN'):'Never', color:'#64748B'},
                {label:'Last File',     value:status?.last_file||'None',                  color:'#64748B'},
              ].map((f,i) => (
                <div key={i} style={{display:'flex',justifyContent:'space-between',padding:'8px 0',borderBottom:i<7?'1px solid #F8FAFC':'none'}}>
                  <span style={{fontSize:12,color:'#64748B',fontWeight:600}}>{f.label}</span>
                  <span style={{fontSize:12,color:f.color,fontWeight:500,maxWidth:220,textAlign:'right',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{f.value}</span>
                </div>
              ))}
            </div>

            {/* File patterns */}
            <div style={{background:'#fff',borderRadius:12,border:'1px solid #C7D9F8',padding:20}}>
              <div style={{fontSize:13,fontWeight:700,color:'#0A1628',marginBottom:12}}>File Name Patterns Detected</div>
              {[
                {type:'Monthly',  color:'#1B4FD8', bg:'#EEF3FD', patterns:'monthly, month, mtd, jan...dec, january...december'},
                {type:'Weekly',   color:'#059669', bg:'#ECFDF5', patterns:'weekly, week, wk, w1, w2, w3, w4'},
                {type:'Daily',    color:'#D97706', bg:'#FFFBEB', patterns:'daily, day, dtd, monday...sunday, mon...sun'},
              ].map(p => (
                <div key={p.type} style={{marginBottom:10,padding:'10px 12px',borderRadius:8,background:p.bg,border:`1px solid ${p.color}20`}}>
                  <div style={{fontSize:12,fontWeight:700,color:p.color,marginBottom:3}}>{p.type} Files</div>
                  <div style={{fontSize:11,color:'#64748B',fontFamily:'monospace'}}>{p.patterns}</div>
                </div>
              ))}
              <div style={{padding:'8px 12px',borderRadius:8,background:'#F0F5FF',border:'1px solid #C7D9F8',fontSize:11,color:'#1B4FD8',marginTop:8}}>
                Supported: .xlsx, .xls, .csv, .pdf, .xlsm
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Processed Files tab */}
      {tab === 'processed' && (
        <div style={{background:'#fff',borderRadius:12,border:'1px solid #C7D9F8',overflow:'hidden'}}>
          <div style={{padding:'14px 18px',borderBottom:'1px solid #EEF3FD',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <div style={{fontSize:13,fontWeight:700,color:'#0A1628'}}>Processed Files ({processed.length})</div>
          </div>
          {processed.length === 0 ? (
            <div style={{padding:48,textAlign:'center',color:'#94A3B8',fontSize:13}}>No files processed yet. Start the monitor and upload files to your Drive folder.</div>
          ) : (
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
              <thead><tr style={{background:'#F0F5FF'}}>
                {['File Name','Type','Processed At','Report Sent To','Action'].map(h => (
                  <th key={h} style={{padding:'10px 14px',textAlign:'left',fontWeight:700,color:'#3B5998',fontSize:11}}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {processed.map((file,i) => (
                  <tr key={file.id} style={{borderTop:'1px solid #F1F5F9'}}>
                    <td style={{padding:'10px 14px',fontWeight:500,color:'#0A1628'}}>{file.name}</td>
                    <td style={{padding:'10px 14px'}}>
                      <span style={{padding:'2px 8px',borderRadius:10,fontSize:10,fontWeight:700,background:(FILE_TYPE_COLORS[file.type]||'#64748B')+'20',color:FILE_TYPE_COLORS[file.type]||'#64748B'}}>
                        {file.type}
                      </span>
                    </td>
                    <td style={{padding:'10px 14px',color:'#64748B'}}>{new Date(file.processed_at).toLocaleString('en-IN')}</td>
                    <td style={{padding:'10px 14px',color:'#64748B',fontSize:11}}>{file.report_sent_to?.join(', ')}</td>
                    <td style={{padding:'10px 14px'}}>
                      <button onClick={() => reprocess(file.id)} style={{padding:'4px 10px',borderRadius:6,border:'1px solid #C7D9F8',background:'#F0F5FF',color:'#1B4FD8',fontSize:11,cursor:'pointer',fontWeight:600}}>Re-process</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Logs tab */}
      {tab === 'logs' && (
        <div style={{background:'#fff',borderRadius:12,border:'1px solid #C7D9F8',overflow:'hidden'}}>
          <div style={{padding:'14px 18px',borderBottom:'1px solid #EEF3FD',fontSize:13,fontWeight:700,color:'#0A1628'}}>Activity Log ({logs.length})</div>
          {logs.length === 0 ? (
            <div style={{padding:40,textAlign:'center',color:'#94A3B8',fontSize:13}}>No activity yet.</div>
          ) : (
            <div style={{maxHeight:500,overflowY:'auto'}}>
              {logs.map((log,i) => (
                <div key={i} style={{padding:'10px 16px',borderBottom:'1px solid #F8FAFC',display:'flex',gap:12,alignItems:'flex-start'}}>
                  <span style={{fontSize:10,fontWeight:700,padding:'2px 6px',borderRadius:4,background:log.level==='error'?'#FEF2F2':log.level==='warn'?'#FFFBEB':'#ECFDF5',color:log.level==='error'?'#DC2626':log.level==='warn'?'#D97706':'#059669',flexShrink:0}}>{log.level?.toUpperCase()}</span>
                  <div style={{flex:1}}>
                    <div style={{fontSize:12,color:'#334155'}}>{log.message}</div>
                    {log.file_name && <div style={{fontSize:11,color:'#94A3B8',marginTop:2}}>{log.file_name}</div>}
                  </div>
                  <div style={{fontSize:10,color:'#94A3B8',flexShrink:0}}>{new Date(log.created_at).toLocaleTimeString('en-IN')}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* How it works tab */}
      {tab === 'how' && (
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:20}}>
          <div style={{background:'#fff',borderRadius:12,border:'1px solid #C7D9F8',padding:24}}>
            <div style={{fontSize:14,fontWeight:700,color:'#0A1628',marginBottom:16}}>How to Set Up (3 Steps)</div>
            {[
              {step:'1',title:'Get Google Drive Folder ID',desc:'Open Google Drive → navigate to your financial reports folder → copy the ID from the URL (the long string after /folders/)'},
              {step:'2',title:'Get Google API Key',desc:'Go to console.cloud.google.com → Create project → Enable Google Drive API → Credentials → Create API Key → Restrict to Drive API'},
              {step:'3',title:'Make Folder Public',desc:'Right-click your Drive folder → Share → Change to Anyone with the link → Viewer → Done. This allows the API key to read files.'},
              {step:'4',title:'Configure & Start',desc:'Enter your folder ID, API key, and recipient emails above. Click Save → Test Connection → Start Monitor.'},
            ].map(s => (
              <div key={s.step} style={{display:'flex',gap:14,marginBottom:16}}>
                <div style={{width:32,height:32,borderRadius:'50%',background:'#1B4FD8',color:'#fff',display:'flex',alignItems:'center',justifyContent:'center',fontSize:14,fontWeight:800,flexShrink:0}}>{s.step}</div>
                <div>
                  <div style={{fontSize:13,fontWeight:700,color:'#0A1628',marginBottom:3}}>{s.title}</div>
                  <div style={{fontSize:12,color:'#64748B',lineHeight:1.5}}>{s.desc}</div>
                </div>
              </div>
            ))}
          </div>
          <div>
            <div style={{background:'#fff',borderRadius:12,border:'1px solid #C7D9F8',padding:24,marginBottom:16}}>
              <div style={{fontSize:14,fontWeight:700,color:'#0A1628',marginBottom:14}}>Autonomous Workflow</div>
              {[
                {icon:'📂',title:'Scan',desc:'Checks your Drive folder every 60 seconds'},
                {icon:'🔍',title:'Detect',desc:'Identifies monthly/weekly/daily financial files by name'},
                {icon:'⬇️',title:'Download',desc:'Retrieves the file from Google Drive'},
                {icon:'🤖',title:'Analyze',desc:'Claude AI analyzes and compares with prior reports'},
                {icon:'📊',title:'Report',desc:'Generates structured executive FOS&A report'},
                {icon:'📧',title:'Email',desc:'Sends report to all configured recipients immediately'},
                {icon:'✅',title:'Track',desc:'Marks file as processed — never re-processes same file'},
              ].map((s,i) => (
                <div key={i} style={{display:'flex',gap:10,marginBottom:10,alignItems:'flex-start'}}>
                  <span style={{fontSize:18,flexShrink:0}}>{s.icon}</span>
                  <div>
                    <span style={{fontSize:12,fontWeight:700,color:'#0A1628'}}>{s.title}: </span>
                    <span style={{fontSize:12,color:'#64748B'}}>{s.desc}</span>
                  </div>
                </div>
              ))}
            </div>
            <div style={{padding:'14px 16px',borderRadius:10,background:'#ECFDF5',border:'1px solid #A7F3D0',fontSize:12,color:'#059669'}}>
              <strong>Each subscriber gets their own monitor</strong> — your folder, your recipients, your API key. Completely isolated from other tenants.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
