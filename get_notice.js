// ===== get_notice.js：CNIPA 审查信息文件查询（复制到 F12 Console 运行）=====
// 输入格式：每行一条「专利号 rid」，空格/Tab 分隔
(function () {
    if (document.getElementById('oa-getnotice-panel')) { alert('面板已存在'); return; }

    // ===== 审查信息文件类型 =====
    var DOC_TYPES = [
        { ds: 'SQWJ', name: '申请文件', path: '/api/view/gn/scxx/sqwj', nodeId: 'aj_gk_scxx_sqwj' },
        { ds: 'ZJWJ', name: '中间文件', path: '/api/view/gn/scxx/zjwj', nodeId: 'aj_gk_scxx_zjwj' },
        { ds: 'TZS',  name: '通知书',   path: '/api/view/gn/scxx/tzs',  nodeId: 'aj_gk_scxx_tzs' }
    ];

    // ===== 认证状态（自动捕获） =====
    var auth = { authorization: '', userType: '', hhp4kgam: '' };

    function captureFromUrl(url) {
        try {
            var u = new URL(url, location.href);
            var v = u.searchParams.get('hHp4Kgam') || u.searchParams.get('hhp4kgam');
            if (v) auth.hhp4kgam = v;
        } catch (e) {}
    }
    function captureHeaders(headers) {
        if (!headers) return;
        try {
            if (headers instanceof Headers) {
                headers.forEach(function(v, k) {
                    var kk = k.toLowerCase();
                    if (kk === 'authorization' && v) auth.authorization = v;
                    if (kk === 'usertype' && v) auth.userType = v;
                    if (kk === 'hhp4kgam' && v) auth.hhp4kgam = v;
                });
            } else if (typeof headers === 'object') {
                Object.keys(headers).forEach(function(k) {
                    var kk = k.toLowerCase(), v = headers[k];
                    if (kk === 'authorization' && v) auth.authorization = v;
                    if (kk === 'usertype' && v) auth.userType = v;
                    if (kk === 'hhp4kgam' && v) auth.hhp4kgam = v;
                });
            }
        } catch (e) {}
    }
    var origFetch = window.fetch;
    window.fetch = function(input, init) {
        captureFromUrl(input);
        if (init && init.headers) captureHeaders(init.headers);
        return origFetch.apply(this, arguments);
    };
    var origOpen = XMLHttpRequest.prototype.open;
    var origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function(method, url) { captureFromUrl(url); return origOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.setRequestHeader = function(k, v) { var h = {}; h[k] = v; captureHeaders(h); return origSetHeader.apply(this, arguments); };

    function scanAuth() {
        captureFromUrl(location.href);
        captureFromUrl(document.cookie.replace(/;\s*/g, '&'));
        try { for (var i=0;i<localStorage.length;i++){ var k=localStorage.key(i), v=localStorage.getItem(k); if(/hhp4kgam/i.test(k)&&v) auth.hhp4kgam=v; if(/authorization/i.test(k)&&v) auth.authorization=v; if(/usertype/i.test(k)&&v) auth.userType=v; } } catch(e){}
        try { for (var i=0;i<sessionStorage.length;i++){ var k=sessionStorage.key(i), v=sessionStorage.getItem(k); if(/hhp4kgam/i.test(k)&&v) auth.hhp4kgam=v; if(/authorization/i.test(k)&&v) auth.authorization=v; if(/usertype/i.test(k)&&v) auth.userType=v; } } catch(e){}
        try { performance.getEntriesByType('resource').slice(-150).forEach(function(e){ captureFromUrl(e.name); }); } catch(e){}
        renderStatus();
    }
    function isAuthReady() { return !!(auth.authorization && auth.userType && auth.hhp4kgam); }

    // ===== 工具函数 =====
    function clean(v) {
        if (v == null) return '';
        if (typeof v === 'string') { var t = v.replace(/\s+/g,' ').trim(); return (t === '--' || t.toLowerCase() === 'null') ? '' : t; }
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        return '';
    }
    function getRoot(d) { if (d && d.data && typeof d.data === 'object') return d.data; return d || {}; }
    function asList(value, names) {
        if (!value) return [];
        if (Array.isArray(value)) return value;
        if (typeof value !== 'object') return [];
        for (var i=0;i<(names||[]).length;i++){ if (Array.isArray(value[names[i]])) return value[names[i]]; }
        var vals = Object.keys(value).map(function(k){return value[k];});
        for (var j=0;j<vals.length;j++){ if (Array.isArray(vals[j])) return vals[j]; }
        return [value];
    }
    function findTextRecursive(root, keys) {
        var seen=[], stack=[root], lower=keys.map(function(k){return String(k).toLowerCase();});
        while(stack.length){
            var item=stack.shift();
            if(!item||typeof item!=='object'||seen.indexOf(item)>-1) continue;
            seen.push(item);
            if(!Array.isArray(item)){
                var ks=Object.keys(item);
                for(var i=0;i<ks.length;i++){
                    if(lower.indexOf(ks[i].toLowerCase())>-1){ var t=clean(item[ks[i]]); if(t) return t; }
                }
            }
            Object.keys(item).forEach(function(k){ if(item[k]&&typeof item[k]==='object') stack.push(item[k]); });
        }
        return '';
    }
    function urlEncode(s) {
        if (s == null) return '';
        try { return encodeURIComponent(s); } catch(e) { return s; }
    }

    // ===== API 调用（通用） =====
    function postApi(url, payload) {
        if(!auth.authorization) return Promise.reject(new Error('未捕获Authorization'));
        var baseHeaders = {'Content-Type':'application/json;charset=utf-8','Accept':'application/json, text/plain, */*','Authorization':auth.authorization};
        if(auth.userType) baseHeaders.userType = auth.userType;

        if(auth.hhp4kgam) url += (url.indexOf('?')>-1?'&':'?') + 'hHp4Kgam=' + encodeURIComponent(auth.hhp4kgam);

        var attempts = [ function(){ return fetch(url, {method:'POST', headers:baseHeaders, body:JSON.stringify(payload), credentials:'include'}).then(function(r){ return {status:r.status, text:r.text().then(function(t){return t;})}; }); } ];
        if(auth.hhp4kgam){
            var hhpHeaders = {}; Object.keys(baseHeaders).forEach(function(k){hhpHeaders[k]=baseHeaders[k];});
            hhpHeaders['Content-Type']='application/json;charset=UTF-8';
            hhpHeaders['Usertype']=auth.userType||''; hhpHeaders['Hhp4kgam']=auth.hhp4kgam;
            attempts.push(function(){
                return new Promise(function(resolve,reject){
                    var xhr=new XMLHttpRequest(); xhr.open('POST',url,true); xhr.withCredentials=true; xhr.timeout=30000;
                    Object.keys(hhpHeaders).forEach(function(k){xhr.setRequestHeader(k,hhpHeaders[k]);});
                    xhr.onreadystatechange=function(){ if(xhr.readyState===4) resolve({status:xhr.status,text:xhr.responseText||''}); };
                    xhr.onerror=function(){reject(new Error('网络请求失败'));};
                    xhr.ontimeout=function(){reject(new Error('网络请求超时'));};
                    xhr.send(JSON.stringify(payload));
                });
            });
        }

        return new Promise(function(resolve,reject){
            var errors=[];
            function tryNext(i){
                if(i>=attempts.length){ reject(new Error(errors.join('；'))); return; }
                attempts[i]().then(function(resp){
                    var text=resp.text;
                    var done=function(t){
                        if(resp.status===401){ auth.authorization=''; errors.push('登录态过期'); tryNext(i+1); return; }
                        var json; try{ json=JSON.parse(t); }catch(e){ errors.push('HTTP '+resp.status+' 非JSON'); tryNext(i+1); return; }
                        if(json.code!==200){ errors.push('code='+json.code); tryNext(i+1); return; }
                        resolve(json);
                    };
                    if(typeof text.then==='function') text.then(done); else done(text);
                }).catch(function(e){ errors.push(e.message||e); tryNext(i+1); });
            }
            tryNext(0);
        });
    }

    // ===== 解析文档列表（scxx 返回） =====
    function parseDocuments(resp) {
        var root = getRoot(resp);
        var list = asList(root, ['records','list','documents','rows','dataList','wenjianList','wenjList']);
        if (!list.length && Array.isArray(root)) list = root;
        return list.filter(function(item){ return item && typeof item === 'object'; });
    }

    // ===== 从响应中提取 rid（rid 就是返回的 nodeId） =====
    function extractRid(resp) {
        var root = getRoot(resp);
        var rid = clean(root['nodeId'] || resp['nodeId']);
        if (rid) return rid;
        var docs = parseDocuments(resp);
        for (var i=0;i<docs.length;i++){
            var r = clean(docs[i]['nodeId']);
            if (r) return r;
        }
        return findTextRecursive(root, ['nodeId', 'rid']);
    }

    // ===== 获取下载链接（fetch-file-infos，返回多个链接） =====
    function getDownloadUrls(appNo, rid, ds, wenjiandm) {
        var payload = { zhuanlisqh: appNo, rid: rid, ds: ds, wenjiandm: wenjiandm };
        return postApi('/api/view/gn/fetch-file-infos', payload).then(function(resp){
            var root = getRoot(resp);
            var ossList = root['ossLujingList'];
            if (!ossList && root.data) ossList = root.data['ossLujingList'];
            if (!ossList || !ossList.length) return [];
            var wenjianhzm = clean(root['wenjianhzm'] || (root.data && root.data['wenjianhzm']));
            var dss = clean(root['ds'] || ds);
            var wdm = clean(root['wenjiandm'] || wenjiandm);
            var base = 'https://cpquery.cponline.cnipa.gov.cn/api/pcshoss/view/fetch-file';
            var urls = [];
            for (var i = 0; i < ossList.length; i++) {
                var o = ossList[i];
                urls.push(base + '?osslujing=' + urlEncode(o['osslujing'])
                    + '&wenjianhzm=' + urlEncode(wenjianhzm)
                    + '&timestamp=' + (o['timestamp']||'')
                    + '&sign=' + urlEncode(o['sign'])
                    + '&isDN=' + (o['isDN']===true)
                    + '&ds=' + urlEncode(dss)
                    + '&wenjiandm=' + urlEncode(wdm));
            }
            return urls;
        }).catch(function(){ return []; });
    }

    // ===== 批量查询 =====
    var rows = [];
    function queryPatent(appNo) {
        var chain = Promise.resolve();
        DOC_TYPES.forEach(function(docType){
            chain = chain.then(function(){
                return postApi(docType.path, { zhuanlisqh: appNo, nodeId: docType.nodeId, anjianbh: '' }).then(function(resp){
                    var root = getRoot(resp);
                    var rid = extractRid(resp);
                    var rootAdditional = root['additionalData'] || {};
                    var docs = parseDocuments(resp);
                    if (!docs.length) return;
                    docs.forEach(function(doc){
                        var docRid = clean(doc['nodeId']) || rid;
                        var docAdditional = doc['additionalData'] || rootAdditional || {};
                        var wenjiandm = clean(doc['wenjiandm'] || docAdditional['wenjiandm'] || doc['code'] || doc['wenjianbh'] || doc['dm'] || doc['wenjianbm']);
                        var name = clean(doc['name'] || doc['wenjianmc'] || doc['mc'] || doc['fileName']);
                        if (!name) name = findTextRecursive(doc, ['wenjianmc','mingcheng','mc','name','fileName']);
                        var row = {
                            '专利号': clean(appNo).toUpperCase().replace(/[^0-9X]/g,''),
                            'rid': docRid,
                            'ds': docType.ds,
                            'wenjiandm': wenjiandm,
                            '文件名称': name,
                            '_appNo': appNo       // 隐藏：用于点击下载
                        };
                        rows.push(row);
                    });
                }).catch(function(e){
                    rows.push({ '专利号': clean(appNo).toUpperCase().replace(/[^0-9X]/g,''), 'rid': '', 'ds': docType.ds, 'wenjiandm': '', '文件名称': '查询失败:'+e.message });
                });
            });
        });
        return chain;
    }

    // 点击文件名称 → 调 fetch-file-infos 获取下载链接并打开（多个文件全部打开）
    function downloadFile(index) {
        var row = rows[index];
        if (!row) return;
        var appNo = row['_appNo'] || row['专利号'];
        var rid = row['rid'];
        var ds = row['ds'];
        var wenjiandm = row['wenjiandm'];
        if (!rid || !ds || !wenjiandm) { alert('缺少 rid/ds/wenjiandm，无法获取下载链接'); return; }
        getDownloadUrls(appNo, rid, ds, wenjiandm).then(function(urls){
            if (!urls.length) {
                alert('未获取到下载链接');
                return;
            }
            urls.forEach(function(url){
                window.open(url, '_blank', 'noreferrer');
            });
        }).catch(function(e){
            alert('获取下载链接失败：' + e.message);
        });
    }

    // ===== UI =====
    var HEADERS = ['专利号','rid','ds','wenjiandm','文件名称'];
    function setProgress(text, showSpinner) {
        var spinner = document.getElementById('oa-gn-spinner');
        var textEl = document.getElementById('oa-gn-progress-text');
        if (spinner) spinner.style.display = showSpinner ? 'inline-block' : 'none';
        if (textEl) textEl.textContent = text;
    }
    function renderStatus(){
        var el=document.getElementById('oa-gn-status'); if(!el) return;
        var p=[];
        p.push('<span class="'+(auth.authorization?'ok':'bad')+'">登录'+(auth.authorization?'正常':'待准备')+'</span>');
        p.push('<span class="'+(auth.userType?'ok':'bad')+'">身份'+(auth.userType?'正常':'待准备')+'</span>');
        p.push('<span class="'+(auth.hhp4kgam?'ok':'bad')+'">环境'+(auth.hhp4kgam?'正常':'待准备')+'</span>');
        el.innerHTML=p.join(' ');
    }
    function renderPreview(){
        var t=document.getElementById('oa-gn-preview'); if(!t) return;
        var html='<thead><tr>'+HEADERS.map(function(h){return '<th>'+h+'</th>';}).join('')+'</tr></thead><tbody>';
        html+=rows.map(function(r, idx){return '<tr>'+HEADERS.map(function(h){
            var v = r[h]||'';
            if (h === '文件名称' && v && v.indexOf('查询失败') !== 0) {
                return '<td><a href="javascript:;" onclick="__oaGN_Download('+idx+')" style="color:#3664d1;text-decoration:underline;">'+esc(v)+'</a></td>';
            }
            return '<td title="'+esc(v)+'">'+esc(v)+'</td>';
        }).join('')+'</tr>';}).join('');
        html+='</tbody>'; t.innerHTML=html;
    }
    window.__oaGN_Download = downloadFile;
    function esc(t){ return clean(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    function start(){
        var input=document.getElementById('oa-gn-input');
        var ids=input.value.split(/[^0-9Xx]+/).map(function(v){return v.trim().toUpperCase();}).filter(function(v){return v.length>=6;});
        if(!ids.length){alert('请先粘贴申请号/专利号');return;}
        if(!isAuthReady()){alert('请先在页面手动查询一个专利，等三项状态都正常');return;}

        rows=[]; renderPreview();
        var i=0;
        function next(){
            if(i>=ids.length){ setProgress('完成，共 '+rows.length+' 条文件记录', false); return; }
            var no=ids[i]; setProgress('查询中 '+(i+1)+'/'+ids.length+'：'+no, true);
            queryPatent(no).then(function(){ renderPreview(); i++; setTimeout(next, 3000 + Math.random()*2000); });
        }
        next();
    }
    function exportXlsx(){
        if(!rows.length){alert('没有数据');return;}
        var aoa=[HEADERS].concat(rows.map(function(r){return HEADERS.map(function(h){return r[h]||'';});}));
        var csv='﻿'+aoa.map(function(c){return c.map(function(x){return '"'+String(x).replace(/"/g,'""')+'"';}).join(',');}).join('\r\n');
        var blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
        var link=document.createElement('a'); link.href=URL.createObjectURL(blob); link.download='CNIPA审查信息文件.csv';
        document.body.appendChild(link); link.click(); link.remove();
    }

    // ===== 面板样式和结构 =====
    var s=document.createElement('style');
    s.textContent='#oa-getnotice-panel{position:fixed;right:16px;top:76px;z-index:999999;width:760px;max-height:calc(100vh - 100px);background:#fff;border:1px solid #b9c6dd;box-shadow:0 8px 28px rgba(0,0,0,.2);font:14px/1.5 Arial,"Microsoft YaHei",sans-serif;overflow:auto;border-radius:8px;}'+
        '#oa-gn-head{background:#3664d1;color:#fff;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;font-size:16px;cursor:move;}'+
        '#oa-gn-body{padding:12px;}'+
        '#oa-gn-input{width:100%;height:80px;border:1px solid #ccc;padding:6px;font:13px/1.4 Consolas,monospace;box-sizing:border-box;}'+
        '#oa-getnotice-panel button{border:1px solid #3664d1;background:#fff;color:#244fc0;border-radius:4px;padding:6px 12px;margin:6px 6px 0 0;cursor:pointer;}'+
        '#oa-getnotice-panel button.primary{background:#3664d1;color:#fff;}'+
        '#oa-gn-status{margin:8px 0;font-size:13px;color:#555;}'+
        '#oa-gn-status .ok{color:#047857;}'+
        '#oa-gn-status .bad{color:#b91c1c;}'+
        '#oa-gn-preview-wrap{overflow:auto;border:1px solid #e2e8f0;margin-top:8px;max-height:400px;}'+
        '#oa-gn-preview{width:100%;border-collapse:collapse;font-size:12px;}'+
        '#oa-gn-preview th,#oa-gn-preview td{border:1px solid #e2e8f0;padding:4px;white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis;}'+
        '#oa-gn-preview th{background:#f8fafc;position:sticky;top:0;}'+
        '#oa-gn-resize{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;background:linear-gradient(135deg,transparent 50%,#999 50%);}'+
        '#oa-gn-head .head-btn{cursor:pointer;padding:0 6px;font-size:16px;line-height:1;margin-left:8px;}'+
        '#oa-gn-spinner{display:none;width:14px;height:14px;border:2px solid #cbd5e1;border-top-color:#3664d1;border-radius:50%;animation:oa-gn-spin 0.7s linear infinite;vertical-align:middle;margin-right:6px;}'+
        '@keyframes oa-gn-spin{to{transform:rotate(360deg);}}';
    document.documentElement.appendChild(s);

    var panel=document.createElement('div');
    panel.id='oa-getnotice-panel';
    panel.innerHTML='<div id="oa-gn-head"><b>审查信息文件查询</b><span><span id="oa-gn-max" class="head-btn" title="最大化/还原">□</span><span id="oa-gn-close" class="head-btn" title="关闭">×</span></span></div>'+
        '<div id="oa-gn-body"><div id="oa-gn-status"></div>'+
        '<textarea id="oa-gn-input" placeholder="每行一个申请号/专利号"></textarea>'+
        '<div><button id="oa-gn-start" class="primary">开始查询</button><button id="oa-gn-export">导出CSV</button><button id="oa-gn-clear">清空</button><button id="oa-gn-refresh">刷新状态</button></div>'+
        '<div id="oa-gn-progress"><span id="oa-gn-spinner"></span><span id="oa-gn-progress-text">等待输入</span></div>'+
        '<div id="oa-gn-preview-wrap"><table id="oa-gn-preview"></table></div></div>';
    document.body.appendChild(panel);

    var resizeHandle=document.createElement('div');
    resizeHandle.id='oa-gn-resize';
    panel.appendChild(resizeHandle);

    var isMax=false, savedRect=null;
    document.getElementById('oa-gn-max').onclick=function(){
        if(!isMax){
            savedRect={left:panel.style.left, top:panel.style.top, width:panel.style.width, height:panel.style.height};
            panel.style.left='0'; panel.style.top='0'; panel.style.width='100vw'; panel.style.height='100vh';
            panel.style.maxHeight='none'; panel.style.maxWidth='none'; isMax=true;
        } else {
            panel.style.left=savedRect.left||''; panel.style.top=savedRect.top||'';
            panel.style.width=savedRect.width||''; panel.style.height=savedRect.height||'';
            panel.style.maxHeight=''; panel.style.maxWidth=''; isMax=false;
        }
    };

    (function(){
        var sx=0, sy=0, sw=0, sh=0;
        resizeHandle.addEventListener('mousedown', function(e){
            e.stopPropagation(); e.preventDefault(); isMax=false;
            sx=e.clientX; sy=e.clientY; sw=panel.offsetWidth; sh=panel.offsetHeight;
            panel.style.width=sw+'px'; panel.style.height=sh+'px';
            panel.style.maxHeight='none'; panel.style.maxWidth='none';
            document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
        });
        function move(e){ panel.style.width=Math.max(360, sw+e.clientX-sx)+'px'; panel.style.height=Math.max(200, sh+e.clientY-sy)+'px'; }
        function up(){ document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); }
    })();

    document.getElementById('oa-gn-close').onclick=function(){panel.style.display='none';};
    document.getElementById('oa-gn-start').onclick=start;
    document.getElementById('oa-gn-export').onclick=exportXlsx;
    document.getElementById('oa-gn-clear').onclick=function(){rows=[];renderPreview();};
    document.getElementById('oa-gn-refresh').onclick=scanAuth;
    setInterval(scanAuth,2000); scanAuth();

    (function makeDraggable(handle){
        var sx=0, sy=0, sl=0, st=0;
        handle.addEventListener('mousedown', function(e){
            sx=e.clientX; sy=e.clientY;
            var rect=panel.getBoundingClientRect(); sl=rect.left; st=rect.top;
            panel.style.right='auto';
            document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
        });
        function move(e){ panel.style.left=Math.max(0, sl+e.clientX-sx)+'px'; panel.style.top=Math.max(0, st+e.clientY-sy)+'px'; }
        function up(){ document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); }
    })(document.getElementById('oa-gn-head'));

    alert('审查信息查询面板已注入！请先手动查询一个专利，等三项状态变绿后再批量查询。');
})();
