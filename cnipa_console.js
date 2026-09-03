// ===== 复制以下全部代码，粘贴到 CNIPA 官网 F12 Console 回车运行000 233=====
(function () {
    if (document.getElementById('oa-cnipa-panel')) { alert('面板已存在'); return; }

    // ===== 接口配置 =====
    var APIS = {
        sqxx:   { path: '/api/view/gn/sqxx',              label: '申请信息' },
        gbggxx: { path: '/api/view/gn/gbggxx',            label: '公告信息' },
        fyxx:   { path: '/api/view/gn/fyxx',              label: '费用信息' },
        zlqzyxx:{ path: '/api/view/gn/get-zlqzydjh-list', label: '质押信息' },
        ssxkba: { path: '/api/view/gn/get-ssxkbah-list',  label: '许可备案' },
        tzs:    { path: '/api/view/gn/scxx/tzs',           label: '通知书信息' }
    };
    var API_KEYS = Object.keys(APIS);
    // 查询速度调节（按 SuperEngine 方案，2026-09-02）：QUERY_CONCURRENCY=同时查询的专利数（固定 1=全串行单飞，勿再调高，
    // 并发≥2 即使配冷却退烧，CNIPA 400 仍占 47% 尝试、耗时钉死）；QUERY_INTERVAL_MS=每件完成后的补位间隔（SuperEngine 550ms 档）
    // —— 查询节奏：按 SuperEngine(1).exe 的速度方案（2026-09-02 用户拍板，放弃「并发2+错峰+冷却救火」路线）——
    //    SuperEngine 逆向规则：单件内接口「串行单飞」、接口间睡 250-350ms；件与件单飞间隔 ~550ms → 任意时刻全站在飞 ≤1，
    //    把瞬时请求密度压到 CNIPA 反爬阈值之下长期跑不触发 400（此前并发≥2 即使加冷却退烧，400 仍占 47% 尝试、耗时不降）。
    //    落地：① QUERY_CONCURRENCY=1（整批逐件串行，见 start/startEnhance 的 while 补位）；
    //    ② 件内 6 接口不齐发，改 queryOne 串行链：上一接口彻底结束（含重试）后睡 250-350ms 再发下一个；
    //    ③ 件间补位 QUERY_INTERVAL_MS(550)+rand*400（≈0.55-0.95s，对应 SuperEngine 批量单飞 550ms）；
    //    ④ 失败接口只重查失败键、整批最多 3 轮（doRetries/enhanceRetries，round>=3 停），与 SuperEngine「失败重试3轮」同构。
    //    冷却退居「保险」：稳态下 coolUntil=0，pacedNet/paceDelay 零额外延迟不拖节奏；
    //    真撞 400/403/405/412/429 只停固定 COOL_BASE_MS(2s) 再继续、不升级——串行在飞=1 不会自激风暴，
    //    升级冻结(3s×2→20s)只会让每次零星 400 白等 4-20s（实测 20件 11 次 400 白耗 40s+，2026-09-02 起改固定短停）。
    var QUERY_CONCURRENCY = 1;
    var QUERY_INTERVAL_MS = 550;   // 件间补位基准（SuperEngine 单飞 550ms）；paceDelay 内叠 rand*400
    var PACE_INTRA_MIN = 250;      // 件内接口间睡眠基准，+rand*100 → 250-350ms（SuperEngine 档位）
    var NET_MAX_ACTIVE = 3;
    var COOL_BASE_MS = 2000;   // 固定短停：撞限流只停 2s 再继续（不再 ×2 升级——串行下不会自激，升级只会白等）
    var COOL_MAX_MS = 2000;    // =BASE，无升级、无退烧
    var COOL_CLEAN_ROWS = 15;
    var coolUntil = 0;    // 短停结束时刻(ms)
    var cleanRows = 0;    // 连续全成功件数（满 COOL_CLEAN_ROWS 提前清零短停）
    var netActive = 0, netQueue = [];  // 在途请求信号量
    function coolRemaining(){ return Math.max(0, coolUntil - Date.now()); }
    function coolReset(){ coolUntil = 0; cleanRows = 0; }
    function triggerCool(){ coolUntil = Date.now() + COOL_BASE_MS; cleanRows = 0; }
    function noteCleanRow(){
        // 连续全成功 COOL_CLEAN_ROWS 件：提前解除可能残留的短停（固定短停，无退烧）
        cleanRows++;
        if(cleanRows >= COOL_CLEAN_ROWS) coolReset();
    }
    function paceDelay(){
        var rem = coolRemaining();
        return (rem > 0 ? rem : 0) + QUERY_INTERVAL_MS + Math.random()*400;
    }
    function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
    // 在途信号量：串行化网络请求，超过上限就排队（fn 返回 Promise）
    function withNetSlot(fn){
        return new Promise(function(resolve, reject){
            netQueue.push({fn:fn, resolve:resolve, reject:reject});
            pumpNet();
        });
    }
    function pumpNet(){
        while(netActive < NET_MAX_ACTIVE && netQueue.length){
            var job = netQueue.shift(); netActive++;
            job.fn().then(function(v){ netActive--; job.resolve(v); pumpNet(); },
                          function(e){ netActive--; job.reject(e); pumpNet(); });
        }
    }
    // 带冷却门的网络请求：冷却中不发新请求，等到冷却结束再发（避免自激重试风暴）
    function pacedNet(fn){
        return new Promise(function(resolve, reject){
            var rem = coolRemaining();
            if(rem > 0){ setTimeout(function(){ withNetSlot(fn).then(resolve, reject); }, rem + 150 + Math.random()*300); }
            else withNetSlot(fn).then(resolve, reject);
        });
    }
    // —— 批次控制：总耗时（暂停/继续按钮已按用户要求删除，另加轻量运行锁防重复开批）——
    var batchActive = false;  // true=有一批（开始查询/更新信息/失败重查）在跑；期间再点这几个按钮直接忽略，防止并发批次互相覆盖 rows
    var batchStartTs = 0;    // 批次开始时刻(ms)，结束消息里显示总耗时
    function fmtElapsed(){
        if(!batchStartTs) return '';
        var s = Math.max(0, Math.round((Date.now()-batchStartTs)/1000));
        var h = Math.floor(s/3600), m = Math.floor(s%3600/60), sec = s%60;
        return (h>0 ? h+':' : '') + (m<10?'0':'') + m + ':' + (sec<10?'0':'') + sec;
    }
    function beginBatch(){ batchActive = true; batchStartTs = Date.now(); }
    function endBatch(){
        batchActive = false;
        // 批量自然结束时：进度条末尾追加错误统计 + 控制台 console.table（供「跑一波数据」看频次）
        if (diag && diag.tries > 0) {
            var line = diagSummaryLine();
            setTimeout(function(){
                var el = document.getElementById('oa-cnipa-progress-text');
                if (el && line) el.textContent += line;
            }, 0);
            try { diagReport(); } catch (e) {}
        }
        // 方案三：批次结束仍有失败行 → 打顽固失败快照（专利号/失败接口/错误摘要）
        try { snapshotFailures(); } catch (e) {}
    }
    // 全部字段（顺序：申请日放在专利类型后面；含「是否保全」=通知书名称含「保全」则代表有保全信息）
    var ALL_HEADERS = ['专利号','专利名称','专利类型','申请日','案件状态','申请人','费用种类','应缴金额','截止日期','代理所','质押状态','授权公告日','法律状态','是否保全','费用状态','最近缴费人','最近缴费种类','变更费','质押信息','许可备案信息'];
    // 默认显示字段（2026-09-03 起恢复 8 个基础列，代理所默认勾选——勾上「代理所」才会让 sqxx 补代理所/确证无则落「无代理所」；
    // 按「字段→接口依赖」裁剪接口计划：默认只跑 sqxx+fyxx 两接口/件（代理所/名称/类型/状态/申请人同源 sqxx）；
    // 勾「质押状态/质押信息/是否保全/许可备案信息/授权公告日」对应 zlqzyxx/tzs/ssxkba/gbggxx —— 选了哪个才多跑哪个接口）
    var DEFAULT_HEADERS = ['专利号','专利名称','专利类型','案件状态','申请人','应缴金额','截止日期','代理所'];
    // key 带日期版：换 key 直接丢弃旧 key 里的旧默认/旧自选，保证新默认列生效
    // （2026-09-03 起代理所回归默认勾选；仍不默认的可选列：质押状态/质押信息/是否保全/许可备案信息/授权公告日，勾了才多跑对应接口）
    var STORAGE_KEY = 'oa_cnipa_headers_20260903';
    // 历史上发过版的默认列（按顺序精确匹配才迁移到最新默认；用户自选过的列不动。
    // 注：无代理所 7 列旧默认不入此表——换 key 已丢弃旧自选；若入表，用户日后手动取消勾选代理所还原成 7 列会在重载时被强行迁回 8 列）
    var SUPERSEDED_DEFAULTS = [
        ['专利号','专利名称','专利类型','申请人','案件状态','应缴金额','截止日期','代理所','质押状态'],
        ['专利号','专利名称','专利类型','申请日','案件状态','是否保全','申请人','应缴金额','截止日期','代理所','质押状态'],
        ['专利号','专利名称','专利类型','案件状态','申请人','应缴金额','截止日期','代理所']
    ];
    function getSelectedHeaders() {
        try {
            var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
            var f = Array.isArray(saved) ? saved.filter(function(h){ return ALL_HEADERS.indexOf(h) > -1; }) : [];
            for (var si=0; si<SUPERSEDED_DEFAULTS.length; si++) {
                var old = SUPERSEDED_DEFAULTS[si];
                if (f.length === old.length && old.every(function(h,i){ return f[i]===h; })) return DEFAULT_HEADERS.slice();
            }
            if (f.length) return f;
        } catch(e) {}
        return DEFAULT_HEADERS.slice();
    }
    function setSelectedHeaders(headers) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(headers.filter(function(h){ return ALL_HEADERS.indexOf(h) > -1; }))); } catch(e) {}
    }
    var selectedHeaders = getSelectedHeaders();
    // ===== 字段→接口依赖：勾了哪些列就只跑这些列需要的接口，没勾的接口不请求（SuperEngine「按可见列裁剪接口计划」同款）=====
    // sqxx 申请信息(名称/类型/申请日/案件状态/申请人/代理所/法律状态)、fyxx 费用(应缴/截止/费用状态…)、gbggxx 公告(授权公告日)、
    // zlqzyxx 质押(质押状态/质押信息)、tzs 通知书(是否保全)、ssxkba 许可备案(许可备案信息)
    var HEADER_API = {
        '专利名称':'sqxx','专利类型':'sqxx','申请日':'sqxx','案件状态':'sqxx','申请人':'sqxx','代理所':'sqxx','法律状态':'sqxx',
        '费用种类':'fyxx','应缴金额':'fyxx','截止日期':'fyxx','费用状态':'fyxx','最近缴费人':'fyxx','最近缴费种类':'fyxx','变更费':'fyxx',
        '授权公告日':'gbggxx',
        '质押状态':'zlqzyxx','质押信息':'zlqzyxx',
        '是否保全':'tzs',
        '许可备案信息':'ssxkba'
    };
    function planForHeaders(headers) {
        var plan = {}; API_KEYS.forEach(function(k){ plan[k]=false; });
        (headers||[]).forEach(function(h){ var k = HEADER_API[h]; if(k) plan[k] = true; });
        return plan;
    }
    function isBlank(v){ return v === undefined || v === null || String(v).trim() === ''; }
    // 「缺什么补什么」：按行看，某个已勾选显示字段仍是空白 → 若它来源接口没「成功取过」就需要查该接口填上。
    // 字段已有数据绝不重查、绝不覆盖（公司搜索出的行已带 名称/类型/状态/申请人，不勾 代理所 就不会去查 sqxx）；
    // 只有「成功取过」才不再重查——含可选接口 404 空记录（确证无质押/许可/通知书等，字段空是最终态）；
    // 取过但失败(ok:false)且字段仍空白 → 仍算缺，更新信息会再查（如 sqxx 404=该号无公开记录，整行空白应能重查并被报失败）。
    function rowNeededApis(row, headers) {
        var need = [], want = {};
        (headers || []).forEach(function(h){
            var k = HEADER_API[h];
            if(!k || want[k]) return;
            if(row._results && row._results[k] && row._results[k].ok) return;  // 该接口已成功取过 → 不再重查
            if(!isBlank(row[h])) return;                                        // 该字段已有数据 → 不覆盖
            want[k] = 1; need.push(k);
        });
        return need;
    }

    // ===== 认证状态 =====
    // hhp4kgam：URL 查询参数里的 hHp4Kgam（buildApiUrl 拼到 URL）
    // hhp4kgamHeader：请求头里的 hhp4kgam（两者前缀/后缀不同，必须分开存）
    var auth = { authorization: '', userType: '', hhp4kgam: '', hhp4kgamHeader: '', dead: false, abnormal: '' };

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
                    if (kk === 'hhp4kgam' && v) auth.hhp4kgamHeader = v;
                });
            } else if (typeof headers === 'object') {
                Object.keys(headers).forEach(function(k) {
                    var kk = k.toLowerCase(), v = headers[k];
                    if (kk === 'authorization' && v) auth.authorization = v;
                    if (kk === 'usertype' && v) auth.userType = v;
                    if (kk === 'hhp4kgam' && v) auth.hhp4kgamHeader = v;
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
        try { for (var i=0;i<localStorage.length;i++){ var k=localStorage.key(i), v=localStorage.getItem(k); if(/hhp4kgam/i.test(k)&&v){ if(!auth.hhp4kgam) auth.hhp4kgam=v; if(!auth.hhp4kgamHeader) auth.hhp4kgamHeader=v; } if(/authorization/i.test(k)&&v) auth.authorization=v; if(/usertype/i.test(k)&&v) auth.userType=v; } } catch(e){}
        try { for (var i=0;i<sessionStorage.length;i++){ var k=sessionStorage.key(i), v=sessionStorage.getItem(k); if(/hhp4kgam/i.test(k)&&v){ if(!auth.hhp4kgam) auth.hhp4kgam=v; if(!auth.hhp4kgamHeader) auth.hhp4kgamHeader=v; } if(/authorization/i.test(k)&&v) auth.authorization=v; if(/usertype/i.test(k)&&v) auth.userType=v; } } catch(e){}
        try { performance.getEntriesByType('resource').slice(-150).forEach(function(e){ captureFromUrl(e.name); }); } catch(e){}
        renderStatus();
    }
    function isAuthReady() { return !!(auth.authorization && auth.userType && auth.hhp4kgam); }
    // 授权三要素自检（口径与 renderStatus 三盏灯一致：登录=authorization、身份=userType、环境=hhp4kgam）。
    // 点「开始查询」/「搜索并查询」前若任一未变绿 → 提示并中止，避免白开一批全是 401/空 token。
    function authReadyOrPrompt(action){
        var missing = [];
        if(!auth.authorization) missing.push('登录');
        if(!auth.userType) missing.push('身份');
        if(!auth.hhp4kgam) missing.push('环境');
        if(missing.length){
            alert(action + '未执行：授权三要素【' + missing.join('、') + '】未就绪（未变绿）。\n\n请先确认已登录 CNIPA 并刷新/正常操作一次页面（让本面板抓到授权请求头）；待下方状态 登录/身份/环境 三盏灯全绿后再点「' + action + '」。');
            setProgress(action + '未执行：授权未就绪【' + missing.join('、') + '】未变绿，待全绿后再试', false);
            return false;
        }
        return true;
    }

    // ===== 工具函数 =====
    function clean(v) {
        if (v == null) return '';
        if (typeof v === 'string') { var t = v.replace(/\s+/g,' ').trim(); return (t === '--' || t.toLowerCase() === 'null') ? '' : t; }
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        return '';
    }
    function getRoot(d) { if (d && d.data && typeof d.data === 'object') return d.data; return d || {}; }
    function getSection(root, name) {
        if (!root || typeof root !== 'object') return {};
        var s = root[name];
        if (!s || typeof s !== 'object') return {};
        if (s[name] && typeof s[name] === 'object') return s[name];
        return s;
    }
    function asList(value, names) {
        if (!value) return [];
        if (Array.isArray(value)) return value;
        if (typeof value !== 'object') return [];
        for (var i=0;i<(names||[]).length;i++){ if (Array.isArray(value[names[i]])) return value[names[i]]; }
        var vals = Object.keys(value).map(function(k){return value[k];});
        for (var j=0;j<vals.length;j++){ if (Array.isArray(vals[j])) return vals[j]; }
        return [value];
    }
    function firstTextByKeys(obj, keys) {
        if (!obj || typeof obj !== 'object') return '';
        for (var i=0;i<keys.length;i++){ if (obj.hasOwnProperty(keys[i])){ var t=clean(obj[keys[i]]); if(t) return t; } }
        return '';
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
    function uniqueJoin(items) {
        var out=[];
        items.forEach(function(item){ var t=clean(item); if(t&&out.indexOf(t)===-1) out.push(t); });
        return out.join('；');
    }
    function parseDate(text) {
        var raw=clean(text); if(!raw) return null;
        var m=raw.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
        if(!m) return null;
        var d=new Date(Number(m[1]),Number(m[2])-1,Number(m[3]));
        return isNaN(d.getTime())?null:d;
    }
    function parseDateRange(text) {
        var raw=clean(text); if(!raw) return [null,null];
        var matches=[];
        var re=/(\d{4})年(\d{1,2})月(\d{1,2})日/g, mm;
        while((mm=re.exec(raw))) matches.push(mm);
        if(matches.length<2){ re=/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/g; matches=[]; while((mm=re.exec(raw))) matches.push(mm); }
        if(matches.length<2) return [null,null];
        function toDate(m){ var d=new Date(Number(m[1]),Number(m[2])-1,Number(m[3])); return isNaN(d.getTime())?null:d; }
        return [toDate(matches[0]),toDate(matches[1])];
    }
    function formatDate(value) {
        var d = (value instanceof Date) ? value : parseDate(value);
        if(!d) return clean(value);
        function pad(n){return String(n).padStart?String(n).padStart(2,'0'):(n<10?'0'+n:''+n);}
        return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
    }
    function cleanAmount(value) {
        var text=clean(value); if(!text) return '';
        var m=text.match(/-?\d+(?:\.\d+)?/); return m?m[0]:text;
    }
    function amountExpr() {
        var parts=[].slice.call(arguments).map(function(p){return clean(p);}).filter(Boolean);
        return parts.join(' + ');
    }
    function inferPatentType(appNo, rawType, grantDate, caseStatus, legalStatus) {
        var base=clean(rawType);
        if(!base){
            var id=clean(appNo).replace(/[^0-9X]/gi,'');
            var marker=id.length>=5?id[4]:'';
            if(marker==='1') base='发明专利'; else if(marker==='2') base='实用新型'; else if(marker==='3') base='外观设计';
        }
        var granted=!!clean(grantDate)||/专利权|有效/.test((caseStatus||'')+' '+(legalStatus||''));
        if(!granted||!base) return base;
        if(base.indexOf('发明')>-1) return '发明已下证';
        if(base.indexOf('实用')>-1) return '实用已下证';
        if(base.indexOf('外观')>-1) return '外观已下证';
        return base;
    }
    function feeRecordText(record, kind) {
        var candidates = {
            type: ['fyzlmc','jfzlmc','zlmc','yingjiaoffyzlmc','yingjiaofjfzlmc','yijiaofjfzlmc','shoujufwfyzlmc','feiyongzlmc','feeType','name'],
            amount: ['jfje','yjje','je','yingjiaoje','yingjiaofjfje','yijiaofjfje','shoujufwjfje','amount','feeAmount'],
            date: ['jzrq','jfrq','rq','jiaofeijzr','yingjiaofjzrq','yingjiaofjfrq','yijiaofjfrq','shoujufwjfsj','date','deadline'],
            status: ['jfzt','fyzt','zt','yingjiaoffyzt','status']
        };
        return firstTextByKeys(record, candidates[kind]||[]);
    }
    function listFromGroup(root, groupName, listNames) {
        var group = root && typeof root === 'object' ? root[groupName] : null;
        if(!group || typeof group !== 'object') return [];
        return asList(group, listNames);
    }

    // ===== 解析申请信息 =====
    function parseSqxx(appNo, sqxx) {
        var root = getRoot(sqxx);
        var zhuluxmxx = getSection(root, 'zhuluxmxx');
        var shenqingren = getSection(root, 'shenqingren');
        var dailijg = getSection(root, 'dailijg');
        var applicantNames = asList(shenqingren, ['shenqingrenList','applicantList']).map(function(item){ return firstTextByKeys(item,['shenqingrxm','shenqingrenxm','shenqingrmc','sqrmc','name','mc']); });
        var agencyNames = asList(dailijg, ['dailijgList','agencyList']).map(function(item){ return firstTextByKeys(item,['dailijgmc','dailijigoumc','jigoumc','dlJGMC','dailijgdm','name','mc']); });
        var patentName = findTextRecursive(zhuluxmxx, ['famingmc','zhuanlimc','zhuanlimingcheng','famingmingcheng','mingcheng','mc']);
        var caseStatus = findTextRecursive(zhuluxmxx, ['anjianywzt','anjianzt','caseStatus']);
        var legalStatus = findTextRecursive(zhuluxmxx, ['falvzt','legalStatus']);
        var rawType = findTextRecursive(zhuluxmxx, ['zhuanlilx','zllx','shenqinglx','leixing']);
        var grantDate = formatDate(findTextRecursive(zhuluxmxx,['shouquanggr','shouquanggrq','sqggr','ggr','grantDate']) || findTextRecursive(root,['shouquanggr','shouquanggrq','sqggr','ggr','grantDate']));
        var applyDate = formatDate(findTextRecursive(zhuluxmxx,['shenqingrq','shenqingr','shenqingdate','sqrq']) || findTextRecursive(root,['shenqingrq','shenqingr','shenqingdate','sqrq']));
        return {
            patentName: patentName, applicant: uniqueJoin(applicantNames), agency: uniqueJoin(agencyNames),
            patentType: inferPatentType(appNo, rawType, grantDate, caseStatus, legalStatus),
            grantDate: grantDate, caseStatus: caseStatus, legalStatus: legalStatus, applyDate: applyDate
        };
    }

    // ===== 解析公告信息 =====
    function parseGrantDateFromGbgg(gbggxx) {
        var root = getRoot(gbggxx);
        var faminggbsqgg = getSection(root, 'faminggbsqgg');
        var rows = asList(faminggbsqgg, ['faminggbsqggList']).filter(function(r){return r&&typeof r==='object';});
        for (var i=0;i<rows.length;i++) {
            var type = firstTextByKeys(rows[i], ['gonggaolx','gllx','gglx','type']);
            if (/实用新型授权公告|发明授权公告/.test(type)) {
                var date = formatDate(firstTextByKeys(rows[i], ['gonggaogbr','gonggaogbrq','ggr','ggrq','date']));
                if (date) return date;
            }
        }
        return '';
    }

    // ===== 解析费用信息 =====
    function parseFee(fyxx) {
        var root = getRoot(fyxx);
        var dueRows = listFromGroup(root, 'yingjiaofei', ['svYingjfList','svYjfList','yingjiaofeiList']);
        var paidRows = listFromGroup(root, 'yijiaofei', ['svYijfList','yijiaofeiList']);
        var lateRows = listFromGroup(root, 'zhinajin', ['svZnjList','zhinajinList']);

        var dueRecords = dueRows.filter(function(r){return r&&typeof r==='object';}).map(function(row){
            return { type: feeRecordText(row,'type'), amount: cleanAmount(feeRecordText(row,'amount')), deadline: formatDate(feeRecordText(row,'date')), status: feeRecordText(row,'status')||'未缴' };
        });
        var restoreRecord = null;
        for (var i=0;i<dueRecords.length;i++){ if(dueRecords[i].amount && dueRecords[i].type.indexOf('恢复')>-1) restoreRecord = dueRecords[i]; }
        var annualRows = dueRecords.filter(function(r){ return r.amount && (!r.type || r.type.indexOf('年费')>-1 || r.type.indexOf('滞纳金')>-1); });

        annualRows.sort(function(a,b){
            var ap = a.status.indexOf('费不足')>-1?0:1, bp = b.status.indexOf('费不足')>-1?0:1;
            if(ap!==bp) return ap-bp;
            var ad=parseDate(a.deadline), bd=parseDate(b.deadline);
            if(ad&&bd) return ad-bd; if(ad) return -1; if(bd) return 1; return 0;
        });

        var changeFee='', recentPayer='', recentPaidType='';
        var changeDates=[];
        for (var j=0;j<paidRows.length;j++) {
            var type = feeRecordText(paidRows[j],'type');
            if(!recentPaidType) recentPaidType = type;
            if(!recentPayer) recentPayer = firstTextByKeys(paidRows[j], ['yijiaofjfrxm','jiaofeiren','jfrxm','payer']);
            if(/著录事项变更费|变更费/.test(type)) { var d=parseDate(feeRecordText(paidRows[j],'date')); if(d) changeDates.push(d); }
        }
        if(changeDates.length){ changeDates.sort(function(a,b){return b-a;}); changeFee = formatDate(changeDates[0].toISOString().slice(0,10)); }

        var annual = annualRows[0] || {};
        var annualType=annual.type||'', annualAmount=annual.amount||'', annualDeadline=annual.deadline||'', annualStatus=annual.status||'';

        var parsedLateRows = lateRows.filter(function(r){return r&&typeof r==='object';}).map(function(row){
            var range = parseDateRange(firstTextByKeys(row, ['zhinajjfsj','jfsj','dateRange']));
            return { start: range[0], end: range[1], fee: cleanAmount(firstTextByKeys(row,['zhinajdqnfje','dqnfje','nianfei'])), lateFee: cleanAmount(firstTextByKeys(row,['zhinajyjznje','yjznje','zhinajin'])), total: cleanAmount(firstTextByKeys(row,['zhinajzj','zj','total'])) };
        }).filter(function(r){return r.start&&r.end;}).sort(function(a,b){return a.end-b.end;});

        var today = new Date(); today.setHours(0,0,0,0);
        var currentLate = null;
        for (var k=0;k<parsedLateRows.length;k++){ if(parsedLateRows[k].start<=today && today<=parsedLateRows[k].end){ currentLate=parsedLateRows[k]; break; } }
        if (currentLate) {
            annualType='年费滞纳金';
            annualAmount = currentLate.fee && currentLate.lateFee ? (currentLate.fee+' + '+currentLate.lateFee) : currentLate.total;
            annualDeadline = formatDate(currentLate.end);
            annualStatus = '滞纳期';
        } else if (parsedLateRows.length && today > parsedLateRows[parsedLateRows.length-1].end) {
            var lastLate = parsedLateRows[parsedLateRows.length-1];
            var restoreAmount = (restoreRecord && restoreRecord.amount) || '1000';
            var restoreDeadline = restoreRecord && restoreRecord.deadline ? parseDate(restoreRecord.deadline) : null;
            annualType = (restoreRecord && restoreRecord.type) || '恢复权利请求费';
            if (restoreDeadline && today > restoreDeadline) {
                annualAmount='---'; annualDeadline=formatDate(restoreDeadline); annualStatus='已失效';
            } else {
                annualAmount = lastLate.fee && lastLate.lateFee ? amountExpr(lastLate.fee, lastLate.lateFee, restoreAmount) : (lastLate.total ? amountExpr(lastLate.total, restoreAmount) : restoreAmount);
                annualDeadline = restoreRecord ? (restoreRecord.deadline||'') : '';
                annualStatus = '期满终止';
            }
        } else if (restoreRecord) {
            annualType = restoreRecord.type || '恢复权利请求费';
            var rd = restoreRecord.deadline ? parseDate(restoreRecord.deadline) : null;
            if (rd && today > rd) { annualAmount='---'; annualDeadline=formatDate(rd); annualStatus='已失效'; }
            else { annualAmount=restoreRecord.amount||'1000'; annualDeadline=restoreRecord.deadline||''; annualStatus=restoreRecord.status||'未缴'; }
        }

        return { annualType:annualType, annualAmount:annualAmount, annualDeadline:annualDeadline, annualStatus:annualStatus, recentPayer:recentPayer, recentPaidType:recentPaidType, changeFee: changeFee||'无' };
    }

    // ===== 解析质押 =====
    function parsePledge(zlqzyxx, sqxx) {
        function directPairs(obj) {
            if(!obj||typeof obj!=='object') return [];
            return Object.keys(obj).filter(function(k){return obj[k]==null||typeof obj[k]!=='object';}).map(function(k){return [k,clean(obj[k])];}).filter(function(p){return p[1];});
        }
        function hasSignal(obj, hint) {
            if(hint && /质押|zhiya|zlqzy|zhiyabh/i.test(String(hint))) return true;
            if(!obj||typeof obj!=='object') return false;
            return directPairs(obj).some(function(p){ return /质押|zhiya|zlqzy|zhiyabh/i.test(p[0]+' '+p[1]); });
        }
        function collect(root) {
            var result=[], seen=[], stack=[{k:'',v:root}];
            while(stack.length){
                var it=stack.shift(), val=it.v;
                if(!val||typeof val!=='object'||seen.indexOf(val)>-1) continue;
                seen.push(val);
                if(Array.isArray(val)){ val.forEach(function(c){stack.push({k:it.k,v:c});}); continue; }
                var list=asList(val,['zlqzyList','zhuanliquanzhiyaList','records','list']);
                if(hasSignal(val,it.k)&&list.length){ list.forEach(function(c){if(c&&typeof c==='object') result.push(c);}); }
                else if(hasSignal(val,it.k)){ result.push(val); }
                Object.keys(val).forEach(function(k){stack.push({k:k,v:val[k]});});
            }
            return result;
        }
        var roots=[getRoot(zlqzyxx),getRoot(sqxx)].filter(function(r){return r&&typeof r==='object';});
        var rows=[];
        roots.forEach(function(root){
            if(Array.isArray(root)){ root.filter(function(i){return i&&typeof i==='object';}).forEach(function(i){rows.push(i);}); }
            else { var known=listFromGroup(root,'zlqzy',['zlqzyList','zhuanliquanzhiyaList','records','list']); if(known.length) rows=rows.concat(known); else rows=rows.concat(collect(root)); }
        });
        var labelMap={zhiyabh:'质押编号',zhiyahtbh:'质押合同号',hetongbh:'合同号',dengjirq:'登记日',zhiyadengjr:'质押登记日',zhiyaqixian:'质押期限',chuzhiren:'出质人',zhiyaren:'质权人',zhaiwuren:'债务人',zhaiquanren:'债权人',zhiyaywzt:'质押状态',zhuangtai:'状态',zt:'状态',gongkaiggh:'公告号'};
        var summaries=[];
        rows.forEach(function(row){
            var pairs=[];
            Object.keys(labelMap).forEach(function(key){ var v=firstTextByKeys(row,[key]); if(v) pairs.push(labelMap[key]+':'+v); });
            if(!pairs.length){ directPairs(row).slice(0,8).forEach(function(p){pairs.push(p[0]+':'+p[1]);}); }
            var s=pairs.join('，'); if(s&&summaries.indexOf(s)===-1) summaries.push(s);
        });
        if(!summaries.length) return {status:'未见质押信息',info:''};
        return {status:'有质押信息',info:summaries.slice(0,3).join(' | ')};
    }

    // ===== 解析许可备案 =====
    function parseLicense(ssxkba) {
        function directPairs(obj){ if(!obj||typeof obj!=='object') return []; return Object.keys(obj).filter(function(k){return obj[k]==null||typeof obj[k]!=='object';}).map(function(k){return [k,clean(obj[k])];}).filter(function(p){return p[1];}); }
        function hasSignal(obj,hint){ if(hint&&/许可|备案|xuke|ssxk|xkba|beian/i.test(String(hint))) return true; if(!obj||typeof obj!=='object') return false; return directPairs(obj).some(function(p){return /许可|备案|xuke|ssxk|xkba|beian/i.test(p[0]+' '+p[1]);}); }
        function collect(root){ var result=[],seen=[],stack=[{k:'',v:root}]; while(stack.length){ var it=stack.shift(),val=it.v; if(!val||typeof val!=='object'||seen.indexOf(val)>-1) continue; seen.push(val); if(Array.isArray(val)){ val.forEach(function(c){stack.push({k:it.k,v:c});}); continue; } var list=asList(val,['ssxkbaList','xukebeianList','records','list']); if(hasSignal(val,it.k)&&list.length){ list.forEach(function(c){if(c&&typeof c==='object') result.push(c);}); } else if(hasSignal(val,it.k)){ result.push(val); } Object.keys(val).forEach(function(k){stack.push({k:k,v:val[k]});}); } return result; }
        var root=getRoot(ssxkba), rows=[];
        if(Array.isArray(root)){ root.filter(function(i){return i&&typeof i==='object';}).forEach(function(i){rows.push(i);}); }
        else if(root&&typeof root==='object'){ var known=listFromGroup(root,'ssxkba',['ssxkbaList','xukebeianList','records','list']); if(known.length) rows=rows.concat(known); else rows=rows.concat(collect(root)); }
        var labelMap={xukebeianh:'备案号',xukebeianbh:'备案号',beianh:'备案号',hetongbah:'备案号',xukehtbh:'许可合同号',hetongbh:'合同号',xukeren:'许可人',beixukeren:'被许可人',xukelx:'许可类型',xukefangshi:'许可方式',beianrq:'备案日期',dengjirq:'登记日期',shengxiaorq:'生效日期',youxiaoqx:'有效期限',zhuangtai:'状态',zt:'状态'};
        var summaries=[];
        rows.forEach(function(row){ var pairs=[]; Object.keys(labelMap).forEach(function(key){ var v=firstTextByKeys(row,[key]); if(v) pairs.push(labelMap[key]+':'+v); }); if(!pairs.length){ directPairs(row).slice(0,8).forEach(function(p){pairs.push(p[0]+':'+p[1]);}); } var s=pairs.join('，'); if(s&&summaries.indexOf(s)===-1) summaries.push(s); });
        if(!summaries.length) return {status:'未见许可备案信息',info:''};
        return {status:'有许可备案信息',info:summaries.slice(0,3).join(' | ')};
    }

    // ===== 解析通知书：名字含「保全」即代表有保全信息 =====
    function parsePreservation(tzs) {
        var root = getRoot(tzs);
        var found = [], seen = [], stack = [root];
        while (stack.length) {
            var item = stack.shift();
            if (!item || typeof item !== 'object' || seen.indexOf(item) > -1) continue;
            seen.push(item);
            if (Array.isArray(item)) { item.forEach(function (c) { stack.push(c); }); continue; }
            Object.keys(item).forEach(function (k) {
                var v = item[k];
                if (typeof v === 'string' && /保全/.test(v)) { var t = clean(v); if (t && found.indexOf(t) === -1) found.push(t); }
                if (v && typeof v === 'object') stack.push(v);
            });
        }
        if (!found.length) return { status: '无保全', info: '' };
        return { status: '有保全', info: found.slice(0, 3).join('；') };
    }

    // ===== 错误统计（诊断用，不影响查询逻辑）=====
    // 每跑完一批（开始查询/更新信息/失败重查）在进度条末尾追加一行错误统计 + 控制台 console.table；
    // 也可随时在控制台执行 window.oaCnipaErrReport() 看当前累计。
    // 目的：用真实数据确认 400/401/404/非JSON/超时到底哪个频繁，再决定要不要改限速策略。
    var diag = { batch: '', tries: 0, ok: 0, byKind: {}, byStatus: {}, byCode: {} };
    function diagReset(tag){
        diag = { batch: tag || '', tries: 0, ok: 0, byKind: {}, byStatus: {}, byCode: {} };
    }
    function diagTry(){ diag.tries++; }
    function diagOk(){ diag.ok++; }
    function diagErr(kind, status, code){
        diag.byKind[kind] = (diag.byKind[kind] || 0) + 1;
        if (status != null) diag.byStatus['HTTP ' + status] = (diag.byStatus['HTTP ' + status] || 0) + 1;
        if (code != null) diag.byCode['code=' + code] = (diag.byCode['code=' + code] || 0) + 1;
    }
    function diagReport(){
        var fail = 0;
        Object.keys(diag.byKind).forEach(function(k){ fail += diag.byKind[k]; });
        var table = [
            { '统计': '批次', '内容': diag.batch || '—' },
            { '统计': '接口调用尝试次数', '内容': diag.tries },
            { '统计': '成功', '内容': diag.ok },
            { '统计': '失败事件(含重试中的偶发)', '内容': fail }
        ];
        Object.keys(diag.byKind).sort().forEach(function(k){
            table.push({ '统计': '失败·' + k, '内容': diag.byKind[k] });
        });
        try { console.table(table); } catch (e) { console.log(table); }
        if (Object.keys(diag.byStatus).length) {
            try { console.table(Object.keys(diag.byStatus).sort().map(function(k){ return { 'HTTP状态': k, '次数': diag.byStatus[k] }; })); } catch (e) {}
        }
        if (Object.keys(diag.byCode).length) {
            try { console.table(Object.keys(diag.byCode).sort().map(function(k){ return { '业务code': k, '次数': diag.byCode[k] }; })); } catch (e) {}
        }
        return JSON.parse(JSON.stringify(diag));
    }
    function diagSummaryLine(){
        var keys = Object.keys(diag.byKind);
        if (!keys.length) return ' | 本次无错误（成功 ' + diag.ok + ' 次）';
        return ' | 错误 ' + keys.map(function(k){ return k + '×' + diag.byKind[k]; }).sort().join(' ') + '（成功 ' + diag.ok + ' 次）';
    }
    // 快照「重试到底仍失败」的行：console.table 输出 专利号 + 失败接口 + 错误摘要，
    // 用来定位 7 条顽固失败是否固定在某个接口/专利类型（是 → 之后可做接口计划裁剪）
    function snapshotFailures(){
        var snaps=[];
        try {
            if(typeof rows !== 'undefined') rows.forEach(function(r){
                if(!r) return;
                var keys = r._failedKeys || [];
                if(!keys.length) return;
                snaps.push({
                    '专利号': r['专利号'] || '',
                    '失败接口': keys.map(function(k){ return APIS[k] ? APIS[k].label : k; }).join('、'),
                    '错误摘要': String(r['查询错误'] || '').slice(0, 200)
                });
            });
        } catch(e){}
        if(!snaps.length) return;
        try { console.table(snaps); } catch(e){ console.log(snaps); }
    }
    window.oaCnipaErrReport = diagReport;

    // ===== API 调用 =====
    function buildApiUrl(apiKey, includeHhp) {
        var path = APIS[apiKey].path;
        if(!includeHhp) return path;
        var hhp = clean(auth.hhp4kgam); if(!hhp) return path;
        return path + (path.indexOf('?')>-1?'&':'?') + 'hHp4Kgam=' + encodeURIComponent(hhp);
    }
    function buildApiPayload(apiKey, appNo) {
        var payload = { zhuanlisqh: appNo };
        if(apiKey==='zlqzyxx'){ payload.nodeId='aj_gk_zlqzy'; payload.anjianbh=''; }
        else if(apiKey==='ssxkba'){ payload.nodeId='aj_gk_ssxkba'; payload.anjianbh=''; }
        else if(apiKey==='tzs'){ payload.nodeId='aj_gk_scxx_tzs'; payload.anjianbh=''; }
        return payload;
    }
    function postJsonFetch(url, headers, payload) {
        return fetch(url, {method:'POST', headers:headers, body:JSON.stringify(payload), credentials:'include'})
            .then(function(r){ return {status:r.status, text: r.text().then(function(t){return t;})}; });
    }
    function postJsonXhr(url, headers, payload) {
        return new Promise(function(resolve,reject){
            var xhr=new XMLHttpRequest(); xhr.open('POST',url,true); xhr.withCredentials=true; xhr.timeout=30000;
            Object.keys(headers).forEach(function(k){xhr.setRequestHeader(k,headers[k]);});
            xhr.onreadystatechange=function(){ if(xhr.readyState===4) resolve({status:xhr.status,text:xhr.responseText||''}); };
            xhr.onerror=function(){reject(new Error('网络请求失败'));};
            xhr.ontimeout=function(){reject(new Error('网络请求超时'));};
            xhr.send(JSON.stringify(payload));
        });
    }
    function isThrottleStatus(s){ return /^(400|403|405|412|429)$/.test(String(s)); }
    function shortBody(t){
        var s = clean(t); if(!s) return '';
        s = s.replace(/\s+/g,' ');
        return s.length > 60 ? ':' + s.slice(0,60) + '…' : ':' + s;
    }
    function callApi(apiKey, appNo) {
        var baseHeaders = {'Content-Type':'application/json;charset=utf-8','Accept':'application/json, text/plain, */*','Authorization':auth.authorization};
        if(auth.userType) baseHeaders.userType = auth.userType;
        var payload = buildApiPayload(apiKey, appNo);
        // 每个请求都过「冷却门 + 在途信号量」：冷却中不发、全站在飞≤3，把突发削平
        var attempts = [ function(){ return pacedNet(function(){ return postJsonFetch(buildApiUrl(apiKey,false), baseHeaders, payload); }); } ];
        if(auth.hhp4kgam || auth.hhp4kgamHeader){
            var hhpHeaders = {}; Object.keys(baseHeaders).forEach(function(k){hhpHeaders[k]=baseHeaders[k];});
            hhpHeaders['Content-Type']='application/json;charset=UTF-8';
            hhpHeaders['Usertype']=auth.userType||''; hhpHeaders['Hhp4kgam']=auth.hhp4kgamHeader || auth.hhp4kgam;
            attempts.push(function(){ return pacedNet(function(){ return postJsonXhr(buildApiUrl(apiKey,true), hhpHeaders, payload); }); });
        }
        var errors=[], saw404=false;
        return new Promise(function(resolve,reject){
            function tryNext(i){
                if(i>=attempts.length){
                    var err = new Error(APIS[apiKey].label+': '+errors.join('；'));
                    if(saw404) err.noRetry = true;   // 申请信息(sqxx)确认 404 = 该申请号无公开记录 → 标记不整体重试
                    reject(err); return;
                }
                diagTry();
                attempts[i]().then(function(resp){
                    var text=resp.text;
                    var done=function(t){
                        // 401 = 登录态过期：清除授权、记录错误、尝试下一个接口，不中断批量查询
                        if(resp.status===401){ auth.authorization=''; diagErr('401登录态过期', resp.status); errors.push('登录态过期'); tryNext(i+1); return; }
                        // 404 = 该接口对这件无记录。多数为可选数据（如没有质押/许可/通知书）→ 按「空数据成功」处理，不重试；
                        // 但 sqxx(申请信息) 404 = 该申请号在 CNIPA 无任何公开记录 → 记为失败(noRetry)，整行空白可被后续重查/报出
                        if(resp.status===404){
                            diagErr('接口404无记录', resp.status);
                            if(apiKey==='sqxx'){ saw404 = true; errors.push('无申请信息记录(404)'); tryNext(i+1); return; }
                            resolve({code:200, data:null}); return;
                        }
                        var throttled = isThrottleStatus(resp.status);
                        if(throttled){ triggerCool(); diagErr('HTTP'+resp.status+'限流', resp.status); }
                        var json; try{ json=JSON.parse(t); }
                        catch(e){
                            if(!throttled) diagErr('HTTP'+resp.status+'非JSON', resp.status);
                            errors.push('HTTP '+resp.status+' 非JSON' + shortBody(t));
                            tryNext(i+1); return;
                        }
                        if(json.code!==200){
                            if(!throttled) diagErr('业务code!=200', null, json.code);
                            errors.push('code='+json.code + (json.msg ? shortBody(json.msg) : ''));
                            tryNext(i+1); return;
                        }
                        diagOk();
                        resolve(json);
                    };
                    if(typeof text.then==='function') text.then(done); else done(text);
                }).catch(function(e){
                    var em = e && e.message ? e.message : String(e);
                    diagErr(/超时|timeout/i.test(em) ? '网络超时' : '网络错误');
                    errors.push(em); tryNext(i+1);
                });
            }
            tryNext(0);
        });
    }

    // ===== 组装行 =====
    function buildRow(appNo, results) {
        var cleaned = clean(appNo).toUpperCase().replace(/[^0-9X]/g,'');
        var sq = results.sqxx && results.sqxx.ok ? parseSqxx(cleaned, results.sqxx.data) : {};
        var grantDate = parseGrantDateFromGbgg((results.gbggxx && results.gbggxx.ok) ? results.gbggxx.data : null) || sq.grantDate || '';
        var fee = results.fyxx && results.fyxx.ok ? parseFee(results.fyxx.data) : {};
        var pledge = results.zlqzyxx && results.zlqzyxx.ok ? parsePledge(results.zlqzyxx.data, results.sqxx && results.sqxx.ok ? results.sqxx.data : null) : {};
        var license = results.ssxkba && results.ssxkba.ok ? parseLicense(results.ssxkba.data) : {};
        var pres = results.tzs && results.tzs.ok ? parsePreservation(results.tzs.data) : {};
        var row = {};
        row['专利号']=cleaned;
        row['专利名称']=sq.patentName||'';
        row['申请日']=sq.applyDate||'';
        row['专利类型']=sq.patentType||'';
        row['案件状态']=sq.caseStatus||'';
        row['申请人']=sq.applicant||'';
        // 代理所：只要 sqxx(申请信息)取到就落行——与「代理所」复选框是否勾选无关，后面勾上该列直接显示，不必重查；
        // 确证无代理机构 → 落「无代理所」（同 质押状态=未见质押信息/是否保全=无保全 的“确证无→明示”口径），不再留空白
        row['代理所']=sq.agency || (results.sqxx && results.sqxx.ok ? '无代理所' : '');
        row['授权公告日']=grantDate||'';
        row['法律状态']=sq.legalStatus||'';
        row['是否保全']=pres.status||'';
        row['费用种类']=fee.annualType||'';
        row['应缴金额']=fee.annualAmount||'';
        row['截止日期']=fee.annualDeadline||'';
        row['费用状态']=fee.annualStatus||'';
        row['最近缴费人']=fee.recentPayer||'';
        row['最近缴费种类']=fee.recentPaidType||'';
        row['变更费']=fee.changeFee||'';
        row['质押状态']=pledge.status||'';
        row['质押信息']=pledge.info||'';
        row['许可备案信息']=license.info||'';
        var failedKeys = API_KEYS.filter(function(k){return results[k] && !results[k].ok;});
        var errs = failedKeys.map(function(k){return APIS[k].label+':'+(results[k].error||'失败');});
        row['查询错误']=errs.join('；');
        row._failedKeys = failedKeys;
        row._results = results;
        row._checked = true;   // 「开始查询」/搜索结果默认全选，方便直接点「更新信息」；勾选框只归更新用，与专利号框无关
        return row;
    }

    // callApi 整轮重试：callApi 内部已试 fetch→XHR 两路，这里对偶发失败（限流/超时/非JSON）再补几轮，
    // 缓解 CNIPA 反爬导致的「查询老是失败」；登录态过期不重试。400 类冷却在 callApi 撞到时已触发（停手等），
    // 这里重试同样等冷却结束再打，不再用旧的 paceExtra「+1200/-400」。
    function callApiWithRetry(apiKey, appNo, rounds) {
        var r = rounds || 2;
        return new Promise(function(resolve, reject){
            function attempt(n){
                callApi(apiKey, appNo).then(resolve).catch(function(e){
                    if(/登录态过期|请登录/i.test(e.message || '')){ reject(e); return; }
                    if(e && e.noRetry){ reject(e); return; }   // 已确认无记录（申请信息404）→ 再试也 404，直接判失败
                    if(n >= r){ reject(e); return; }
                    var rem = coolRemaining();
                    setTimeout(function(){ attempt(n+1); }, (rem > 0 ? rem : 0) + 900*n + Math.random()*300);
                });
            }
            attempt(1);
        });
    }
    function queryOne(no, plan) {
        var keys = API_KEYS.filter(function(k){ return plan[k]; });
        // 仿 SuperEngine：件内接口「串行单飞」——上一个请求彻底结束（含重试）后睡 250-350ms 再发下一个。
        // 不再 Promise.all 齐发/400ms 错峰：CNIPA 限流看的是任意瞬间在飞数与请求密度，全串行把速率压到稳态档。
        var results = {};
        var chain = Promise.resolve();
        keys.forEach(function(k, idx){
            chain = chain.then(function(){
                // 第 2 个接口起，与上一个接口间隔 PACE_INTRA_MIN + rand*100 ms（SuperEngine 250-350ms 档位）
                if(idx > 0) return sleep(PACE_INTRA_MIN + Math.random()*100);
            }).then(function(){
                return callApiWithRetry(k, no).then(function(d){ results[k] = {ok:true, data:d}; })
                                               .catch(function(e){ results[k] = {ok:false, error:e.message}; });
            });
        });
        return chain.then(function(){
            // 整件全部接口成功：计一件「干净行」，连续 COOL_CLEAN_ROWS 件彻底解除冷却保险
            if(keys.every(function(k){ return results[k] && results[k].ok; })) noteCleanRow();
            return results;
        });
    }

    // 增量填空：把 keys 中取到的结果并入 _results（成功才覆盖，首次失败也记录以便 _failedKeys 追踪），
    // 再用合并结果重建「候选值」——但只把「当前仍为空白」的显示字段填进去。已有数据的字段绝不覆盖：
    // 公司搜索出的行带预填的 名称/类型/状态/申请人，只补费用等空字段时绝不会被重建抹掉。
    function fillRowBlanks(row, no, results, keys) {
        var merged = row._results || {};
        keys.forEach(function(k){
            if(results[k] && results[k].ok) merged[k] = results[k];
            else if(results[k] && !merged[k]) merged[k] = results[k];
        });
        row._results = merged;
        var cand = buildRow(no, merged);
        ALL_HEADERS.forEach(function(h){ if(isBlank(row[h]) && !isBlank(cand[h])) row[h] = cand[h]; });
        row._failedKeys = API_KEYS.filter(function(k){return merged[k] && !merged[k].ok;});
        row['查询错误'] = row._failedKeys.map(function(k){ return APIS[k].label + ':' + ((merged[k]||{}).error || '失败'); }).join('；');
    }
    // 重试单行的失败接口（只重查失败键，取到后只填空）
    function retryRow(row, no) {
        var failedKeys = row._failedKeys || [];
        if(!failedKeys.length) return Promise.resolve();
        var plan = {}; API_KEYS.forEach(function(k){plan[k]=false;}); failedKeys.forEach(function(k){plan[k]=true;});
        return queryOne(no, plan).then(function(results){
            fillRowBlanks(row, no, results, failedKeys);
            return;
        });
    }

    // ===== UI =====
    var rows=[];
    function setProgress(text, showSpinner) {
        var spinner = document.getElementById('oa-cnipa-spinner');
        var textEl = document.getElementById('oa-cnipa-progress-text');
        if (spinner) spinner.style.display = showSpinner ? 'inline-block' : 'none';
        if (textEl) textEl.textContent = text;
    }
    function renderStatus(){
        var el=document.getElementById('oa-cnipa-status'); if(!el) return;
        var p=[];
        p.push('<span class="'+(auth.authorization?'ok':'bad')+'">登录'+(auth.authorization?'正常':'待准备')+'</span>');
        p.push('<span class="'+(auth.userType?'ok':'bad')+'">身份'+(auth.userType?'正常':'待准备')+'</span>');
        p.push('<span class="'+(auth.hhp4kgam?'ok':'bad')+'">环境'+(auth.hhp4kgam?'正常':'待准备')+'</span>');
        el.innerHTML=p.join(' ');
    }
    // ===== CNIPA 专利详情页 =====
    // 详情页真实地址是 /detail/index?zhuanlisqh=<加密串>&anjianbh&searchType=1，
    // 其中 zhuanlisqh 是把申请号 AES 加密成 16 字节后的 Base64（再双重 URL 编码）。
    // 我们拿不到加密密钥，但 CNIPA 各接口的返回里通常会带这个令牌
    // （16 字节密文的 Base64 形态「22 字符 + ==」，或 32 位十六进制形态）。
    // 点「详情」时按申请号从返回里实时提取令牌再打开，保证打开的是真实详情页。
    var detailTokenCache = {};
    // ===== 详情令牌扫描 =====
    // 令牌是申请号加密后的 16 字节：Base64 形态「22 字符 + ==」，或 32 位十六进制。
    // 有些响应里令牌带 URL 编码（%3D%3D），先解码再匹配，避免漏掉。
    function isTokenBase64(s){ return /^[A-Za-z0-9+\/]{22}==$/.test(s); }
    function isTokenHex(s){ return /^[0-9a-fA-F]{32}$/.test(s); }
    function urlDecodeAll(s){
        var out=[s];
        try{
            var d=decodeURIComponent(s);
            if(d!==s){ out.push(d); try{ var d2=decodeURIComponent(d); if(d2!==d) out.push(d2); }catch(e2){} }
        }catch(e){}
        return out;
    }
    function scanToken(obj, preferHex){
        var seen=[], stack=[obj], found=[];
        while(stack.length){
            var item=stack.shift();
            if(!item || typeof item !== 'object' || seen.indexOf(item) > -1) continue;
            seen.push(item);
            if(Array.isArray(item)){ item.forEach(function(c){ stack.push(c); }); continue; }
            Object.keys(item).forEach(function(k){
                var v = item[k];
                if(typeof v === 'string'){
                    var forms = urlDecodeAll(clean(v));
                    for(var i=0;i<forms.length;i++){
                        var s=forms[i];
                        if(isTokenBase64(s) && found.indexOf(s) === -1) found.push(s);
                        else if(preferHex && isTokenHex(s) && found.indexOf(s) === -1) found.push(s);
                    }
                }
                if(v && typeof v === 'object') stack.push(v);
            });
        }
        return found;
    }
    // 在搜索响应里找「申请号字段 == appNo」的对象，再取其令牌
    function findObjWithAppNo(data, appNo){
        var seen=[], stack=[data], out=[];
        var keyRe = /zhuanlisqh|shenqingh|shenqinghao|appno|applicationnumber/i;
        while(stack.length){
            var item = stack.shift();
            if(!item || typeof item !== 'object' || seen.indexOf(item) > -1) continue;
            seen.push(item);
            if(Array.isArray(item)){ item.forEach(function(c){ stack.push(c); }); continue; }
            var hit = false;
            Object.keys(item).forEach(function(k){
                if(keyRe.test(k)){
                    var s=clean(item[k]).toUpperCase().replace(/[^0-9X]/g,'');
                    // 兼容带类型代码的申请号（如 2010101995057 与 20101019950575），做前缀匹配
                    if(s === appNo || s.indexOf(appNo) === 0 || appNo.indexOf(s) === 0) hit = true;
                }
            });
            if(hit) out.push(item);
            Object.keys(item).forEach(function(k){ var v=item[k]; if(v && typeof v === 'object') stack.push(v); });
        }
        return out;
    }
    function extractTokenForAppNo(json, appNo){
        var objs = findObjWithAppNo(json, appNo);
        for(var i=0;i<objs.length;i++){
            var t = scanToken(objs[i], true);
            for(var j=0;j<t.length;j++){ if(isTokenBase64(t[j])) return t[j]; }
            if(t.length) return t[0];
        }
        var all = scanToken(json, true);
        for(var j=0;j<all.length;j++){ if(isTokenBase64(all[j])) return all[j]; }
        if(all.length) return all[0];
        return '';
    }
    // 从本次批量查询已存下的原始响应里找令牌（免额外请求，瞬间打开）
    function scanRowsToken(appNo){
        var key = clean(appNo).toUpperCase().replace(/[^0-9X]/g,'');
        for(var i=0;i<rows.length;i++){
            if(clean(rows[i]['专利号']).toUpperCase().replace(/[^0-9X]/g,'') !== key) continue;
            var res = rows[i]._results; if(!res) continue;
            var list = [];
            Object.keys(res).forEach(function(k){ if(res[k] && res[k].data) list.push(res[k].data); });
            list.push(res);
            for(var m=0;m<list.length;m++){
                var t = scanToken(list[m], true);
                for(var j=0;j<t.length;j++){ if(isTokenBase64(t[j])) return t[j]; }
                if(t.length) return t[0];
            }
        }
        return '';
    }
    function firstResponseKeys(obj, max){
        if(!obj || typeof obj !== 'object') return '';
        var seen=[], stack=[obj], out=[];
        while(stack.length && out.length < (max||10)){
            var item = stack.shift();
            if(!item || typeof item !== 'object' || seen.indexOf(item) > -1) continue;
            seen.push(item);
            if(Array.isArray(item)){ item.forEach(function(c){ stack.push(c); }); continue; }
            Object.keys(item).forEach(function(k){
                if(out.length >= (max||10)) return;
                if(out.indexOf(k) === -1) out.push(k);
            });
            Object.keys(item).forEach(function(k){ var v=item[k]; if(v && typeof v === 'object') stack.push(v); });
        }
        return out.join(', ');
    }
    function buildDetailUrl(token){
        var base = (location && location.origin) ? location.origin : 'https://cpquery.cponline.cnipa.gov.cn';
        return base + '/detail/index?zhuanlisqh=' + encodeURIComponent(encodeURIComponent(token)) + '&anjianbh&searchType=1';
    }
    // ===== CNIPA 详情令牌 =====
    // zhuanlisqh 是申请号 AES 加密成 16 字节后的 Base64。密钥从前端 app 代码里直接提取：
    // webpack 模块 e35c（chunk-common.fba77062.js）里的 CryptoJS 封装：
    //   AES.encrypt(明文, enc.Utf8.parse(密钥), {mode:ECB, padding:Pkcs7}).toString() → Base64
    // 密钥即 e35c 的默认参数 "ABCDEF0123456789"（16 字节 ASCII，AES-128-ECB）。
    // 两个已知明文→密文对验证通过：2010101995057→BpRh5OIjHkrDteCWxp6oVw==，
    // 2024113496352→dQQWnYZuRd3tg8jnSRIetw==。
    var KNOWN_TOKEN_PAIRS = [
        { appNo: '2010101995057', token: 'BpRh5OIjHkrDteCWxp6oVw==' },
        { appNo: '2024113496352', token: 'dQQWnYZuRd3tg8jnSRIetw==' }
    ];
    // 硬编码密钥（strToBytes 为函数声明，先于本行定义，可直接调用）
    var detailCrypto = { algo: 'aes', key: strToBytes('ABCDEF0123456789') };
    // init 时用已知令牌对验证一次：若 CNIPA 更换密钥导致失败，清空 detailCrypto，
    // openDetail 会自动降级到「搜索响应提取令牌」→「动态发现」两条兜底路径。
    try{
        testCryptoKey(detailCrypto.algo, detailCrypto.key).then(function(ok){
            if(!ok){ detailCrypto = null; }
        }).catch(function(){ detailCrypto = null; });
    }catch(e){}
    function strToBytes(s){ var out=new Uint8Array(s.length); for(var i=0;i<s.length;i++) out[i]=s.charCodeAt(i); return out; }
    function bytesToB64(bytes){ var bin=''; for(var i=0;i<bytes.length;i++) bin+=String.fromCharCode(bytes[i]); return btoa(bin); }
    function pkcs7PadBytes(b){
        var n=16-(b.length%16), out=new Uint8Array(b.length+n);
        out.set(b); for(var i=0;i<n;i++) out[b.length+i]=n;
        return out;
    }
    // AES-128（单块：CBC 零 IV 等价 ECB；WebCrypto 原生不提供 ECB）
    function aesEcbEncrypt(keyBytes, block){
        return crypto.subtle.importKey('raw', keyBytes, {name:'AES-CBC'}, false, ['encrypt']).then(function(k){
            return crypto.subtle.encrypt({name:'AES-CBC', iv:new Uint8Array(16)}, k, block);
        }).then(function(ct){ return new Uint8Array(ct).slice(0,16); });
    }
    // 国密 SM4（GB/T 32907-2016）
    var SM4_SBOX=[0xd6,0x90,0xe9,0xfe,0xcc,0xe1,0x3d,0xb7,0x16,0xb6,0x14,0xc2,0x28,0xfb,0x2c,0x05,
        0x2b,0x67,0x9a,0x76,0x2a,0xbe,0x04,0xc3,0xaa,0x44,0x13,0x26,0x49,0x86,0x06,0x99,
        0x9c,0x42,0x50,0xf4,0x91,0xef,0x98,0x7a,0x33,0x54,0x0b,0x43,0xed,0xcf,0xac,0x62,
        0xe4,0xb3,0x1c,0xa9,0xc9,0x08,0xe8,0x95,0x80,0xdf,0x94,0xfa,0x75,0x8f,0x3f,0xa6,
        0x47,0x07,0xa7,0xfc,0xf3,0x73,0x17,0xba,0x83,0x59,0x3c,0x19,0xe6,0x85,0x4f,0xa8,
        0x68,0x6b,0x81,0xb2,0x71,0x64,0xda,0x8b,0xf8,0xeb,0x0f,0x4b,0x70,0x56,0x9d,0x35,
        0x1e,0x24,0x0e,0x5e,0x63,0x58,0xd1,0xa2,0x25,0x22,0x7c,0x3b,0x01,0x21,0x78,0x87,
        0xd4,0x00,0x46,0x57,0x9f,0xd3,0x27,0x52,0x4c,0x36,0x02,0xe7,0xa0,0xc4,0xc8,0x9e,
        0xea,0xbf,0x8a,0xd2,0x40,0xc7,0x38,0xb5,0xa3,0xf7,0xf2,0xce,0xf9,0x61,0x15,0xa1,
        0xe0,0xae,0x5d,0xa4,0x9b,0x34,0x1a,0x55,0xad,0x93,0x32,0x30,0xf5,0x8c,0xb1,0xe3,
        0x1d,0xf6,0xe2,0x2e,0x82,0x66,0xca,0x60,0xc0,0x29,0x23,0xab,0x0d,0x53,0x4e,0x6f,
        0xd5,0xdb,0x37,0x45,0xde,0xfd,0x8e,0x2f,0x03,0xff,0x6a,0x72,0x6d,0x6c,0x5b,0x51,
        0x8d,0x1b,0xaf,0x92,0xbb,0xdd,0xbc,0x7f,0x11,0xd9,0x5c,0x41,0x1f,0x10,0x5a,0xd8,
        0x0a,0xc1,0x31,0x88,0xa5,0xcd,0x7b,0xbd,0x2d,0x74,0xd0,0x12,0xb8,0xe5,0xb4,0xb0,
        0x89,0x69,0x97,0x4a,0x0c,0x96,0x77,0x7e,0x65,0xb9,0xf1,0x09,0xc5,0x6e,0xc6,0x84,
        0x18,0xf0,0x7d,0xec,0x3a,0xdc,0x4d,0x20,0x79,0xee,0x5f,0x3e,0xd7,0xcb,0x39,0x48];
    function sm4Rotl(x,n){ return ((x<<n)|(x>>>(32-n)))>>>0; }
    function sm4KeySchedule(key){
        var MK=[],i,j,b;
        for(i=0;i<4;i++) MK.push(((key[i*4]<<24)|(key[i*4+1]<<16)|(key[i*4+2]<<8)|key[i*4+3])>>>0);
        var FK=[0xa3b1bac6,0x56aa3350,0x677d9197,0xb27022dc], CK=[], K=[], rk=[];
        for(i=0;i<32;i++){ b=0; for(j=0;j<4;j++) b=((b*256)+(((4*i+j)*7)&0xff))>>>0; CK.push(b); }
        for(i=0;i<4;i++) K.push((MK[i]^FK[i])>>>0);
        for(i=0;i<32;i++){
            var x=(K[i+1]^K[i+2]^K[i+3]^CK[i])>>>0;
            var y=(SM4_SBOX[(x>>24)&0xff]<<24|SM4_SBOX[(x>>16)&0xff]<<16|SM4_SBOX[(x>>8)&0xff]<<8|SM4_SBOX[x&0xff])>>>0;
            rk.push((K[i]^(y^sm4Rotl(y,13)^sm4Rotl(y,23)))>>>0);
            K.push(rk[i]);
        }
        return rk;
    }
    function sm4EncryptBlock(blk, rk){
        var X=[],i;
        for(i=0;i<4;i++) X.push(((blk[i*4]<<24)|(blk[i*4+1]<<16)|(blk[i*4+2]<<8)|blk[i*4+3])>>>0);
        for(i=0;i<32;i++){
            var x=(X[i+1]^X[i+2]^X[i+3]^rk[i])>>>0;
            var y=(SM4_SBOX[(x>>24)&0xff]<<24|SM4_SBOX[(x>>16)&0xff]<<16|SM4_SBOX[(x>>8)&0xff]<<8|SM4_SBOX[x&0xff])>>>0;
            X.push((X[i]^(y^sm4Rotl(y,2)^sm4Rotl(y,10)^sm4Rotl(y,18)^sm4Rotl(y,24)))>>>0);
        }
        var out=new Uint8Array(16);
        for(i=0;i<4;i++){ var w=X[35-i]; out[i*4]=w>>>24; out[i*4+1]=(w>>16)&0xff; out[i*4+2]=(w>>8)&0xff; out[i*4+3]=w&0xff; }
        return out;
    }
    function sm4EcbEncrypt(keyBytes, block){ return Promise.resolve(sm4EncryptBlock(block, sm4KeySchedule(keyBytes))); }
    function collectLoadedJs(){
        var urls=[], push=function(u){ if(u && /\.js(\?|$)/i.test(u) && urls.indexOf(u)===-1) urls.push(u); };
        try{ (performance.getEntriesByType('resource')||[]).forEach(function(e){ push(e.name); }); }catch(e){}
        var ss=document.querySelectorAll('script[src]');
        Array.prototype.forEach.call(ss,function(s){ push(s.src); });
        // 页面 HTML 本身（密钥可能直接写在内联脚本/配置里）
        try{ urls.push('html:root'); }catch(e){}
        // 内联 <script> 内容（无 src）
        try{
            var inline=document.querySelectorAll('script:not([src])');
            for(var i=0;i<inline.length;i++){
                if(inline[i].textContent && inline[i].textContent.length>4) urls.push('inline:'+i);
            }
        }catch(e){}
        // webpack 分块里已执行的模块（不重新请求网络，直接读源码）
        try{
            Object.keys(window).forEach(function(k){
                if(k.indexOf('webpackChunk')!==0) return;
                var arr=window[k];
                if(!arr || !arr.length) return;
                for(var i=0;i<arr.length;i++){
                    var m=arr[i] && arr[i][1];
                    if(!m || typeof m!=='object') continue;
                    Object.keys(m).forEach(function(id){ if(typeof m[id]==='function') push('webpack-module:'+id); });
                }
            });
        }catch(e){}
        return urls;
    }
    function fetchJsText(url){
        if(url.indexOf('html:root')===0){
            try{ return Promise.resolve(document.documentElement.outerHTML || document.documentElement.innerHTML || ''); }catch(e){ return Promise.resolve(''); }
        }
        if(url.indexOf('inline:')===0){
            var ii=parseInt(url.slice('inline:'.length),10), txt='';
            try{
                var ins=document.querySelectorAll('script:not([src])');
                if(ins[ii]) txt=ins[ii].textContent || '';
            }catch(e){}
            return Promise.resolve(txt);
        }
        if(url.indexOf('webpack-module:')===0){
            var id=url.slice('webpack-module:'.length), txt='';
            try{
                Object.keys(window).forEach(function(k){
                    if(k.indexOf('webpackChunk')!==0) return;
                    var arr=window[k]; if(!arr || !arr.length) return;
                    for(var i=0;i<arr.length;i++){
                        var m=arr[i] && arr[i][1];
                        if(m && m[id] && typeof m[id]==='function') txt += m[id].toString() + '\n';
                    }
                });
            }catch(e){}
            return Promise.resolve(txt);
        }
        return fetch(url, {credentials:'include'}).then(function(r){ return r.text(); }).catch(function(){ return ''; });
    }
    function extractKeyCandidates(text){
        var out=[], seen={}, m, push=function(s){
            if(!s) return; s=s.trim();
            if(s.length<4 || s.length>80 || seen[s]) return;
            if(/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)) return; // 纯标识符不会是密钥
            seen[s]=true; out.push(s);
        };
        // 先剔除 data: 内嵌资源（base64 图片等），否则 re4/re8 会把整块 base64 切成海量候选
        text=text.replace(/data:[^'")\s]{60,}/g,'');
        // 1) 加密调用附近的字符串（CryptoJS.enc.Utf8.parse("KEY")、AES.encrypt("KEY"...) 等）
        var re=/(?:encrypt|decrypt|parse|key|KEY|Secret|secret|iv|IV)\s*[\(\.\s]*["']([A-Za-z0-9+/=_.@!#$%^&\-]{4,80})["']/g;
        while((m=re.exec(text))) push(m[1]);
        // 2) key: "..." / key = "..." / secret = "..."
        var re2=/(?:key|KEY|Secret|secret|k)\s*[:=]\s*["']([A-Za-z0-9+/=_.@!#$%^&\-]{4,80})["']/g;
        while((m=re2.exec(text))) push(m[1]);
        // 3) 16 字节 base64 / 16 或 32 位 hex 字符串
        var re4=/["']([A-Za-z0-9+/]{20,24}==?|[0-9a-fA-F]{16}|[0-9a-fA-F]{32})["']/g;
        while((m=re4.exec(text))) push(m[1]);
        // 4) 任意恰好 16 字符的引号字符串（密钥很可能就是裸 16 位 ASCII，如 "cnipaDetailKey!"）
        var re5=/["']([^"'\\\n]{16})["']/g;
        while((m=re5.exec(text))) push(m[1]);
        // 5) 字节数组 [0x??, 0x??, ... 共16项]
        var re6=/\[\s*0x[0-9a-fA-F]{2}\s*(?:,\s*0x[0-9a-fA-F]{2}\s*){15}\]/g;
        while((m=re6.exec(text))){
            var hex=m[0].replace(/[\[\],\s]/g,'').replace(/0x/gi,'');
            push(hex);
        }
        // 6) 空格/逗号分隔的 16 组两位 hex（如 "2b 7e 15 16 28 ae d2 a6 ab f7 15 88 09 cf 4f 3c"）
        var re7=/(?:[0-9a-fA-F]{2}[,\s]+){15}[0-9a-fA-F]{2}/g;
        while((m=re7.exec(text))) push(m[0]);
        // 7) URL-safe base64（含 - 与 _，22 字符 + 2 个=）
        var re8=/["']([A-Za-z0-9\-_]{20,24}==?)["']/g;
        while((m=re8.exec(text))) push(m[1]);
        return out;
    }
    function deriveKeyBytes(str){
        var out=[];
        if(/^[0-9a-fA-F]{16}$/.test(str) || /^[0-9a-fA-F]{32}$/.test(str)){
            var hex=str.length===32?str:str+str, b=new Uint8Array(16);
            for(var j=0;j<16;j++) b[j]=parseInt(hex.substr(j*2,2),16);
            return [b];
        }
        // base64 解码后恰好 16 字节（密钥以 b64 形式存在代码里；atob 自带合法性校验，非法就抛错跳过）
        try{
            var b64=str.replace(/-/g,'+').replace(/_/g,'/');
            if(/^[A-Za-z0-9+/]*={0,2}$/.test(b64)){
                var dec=strToBytes(atob(b64));
                if(dec.length===16){ out.push(new Uint8Array(dec)); }
                else if(dec.length===32){ var h=new Uint8Array(16); h.set(dec.slice(0,16)); out.push(h); }
            }
        }catch(e){}
        var raw=strToBytes(str);
        var b1=new Uint8Array(16); b1.set(raw.slice(0,16)); out.push(b1);
        if(raw.length<16){ var b2=new Uint8Array(16); b2.set(raw); out.push(b2); }
        return out;
    }
    function testCryptoKey(algo, keyBytes){
        return Promise.all(KNOWN_TOKEN_PAIRS.map(function(p){
            var block=pkcs7PadBytes(strToBytes(p.appNo));
            var enc=(algo==='aes')?aesEcbEncrypt(keyBytes,block):sm4EcbEncrypt(keyBytes,block);
            return enc.then(function(ct){ return bytesToB64(ct)===p.token; });
        })).then(function(rs){ return rs.indexOf(false)===-1; });
    }
    function discoverCryptoKey(){
        if(detailCrypto) return Promise.resolve(detailCrypto);
        if(window.__oaDetailCryptoBusy) return window.__oaDetailCryptoBusy;
        var diag={scanned:[], candidates:[], tried:0, start:new Date().getTime()};
        var urls=collectLoadedJs();
        window.__oaDetailCryptoBusy=Promise.all(urls.map(function(u){
            return fetchJsText(u).then(function(t){
                diag.scanned.push({url:u, len:(t||'').length});
                return t||'';
            });
        }))
            .then(function(texts){
                var candidates=[], seenStr={}, MAXC=800;
                texts.forEach(function(t){ extractKeyCandidates(t).forEach(function(c){ if(candidates.length<MAXC && !seenStr[c]){ seenStr[c]=true; candidates.push(c); } }); });
                diag.candidates=candidates;
                diag.candidatesCapped=candidates.length>=MAXC;
                var tries=[];
                candidates.forEach(function(c){
                    deriveKeyBytes(c).forEach(function(kb){ tries.push({algo:'aes',key:kb}); tries.push({algo:'sm4',key:kb}); });
                });
                diag.tried=tries.length;
                var idx=0;
                function loop(){
                    if(idx>=tries.length) return Promise.resolve(null);
                    var t=tries[idx++];
                    return testCryptoKey(t.algo,t.key).then(function(ok){ return ok?t:loop(); });
                }
                return loop();
            })
            .then(function(found){
                if(found){
                    detailCrypto={algo:found.algo,key:found.key};
                    try{ localStorage.setItem('oa_cnipa_detail_crypto', JSON.stringify({algo:found.algo, keyB64:bytesToB64(found.key)})); }catch(e){}
                    console.log('[oa] 已提取 CNIPA 详情令牌密钥: algo='+found.algo+', key(b64)='+bytesToB64(found.key));
                    return detailCrypto;
                }
                // 失败诊断：列出扫了哪些资源、提取了多少候选、试了多少组，方便定位密钥到底藏在哪
                var secs=((new Date().getTime()-diag.start)/1000).toFixed(1);
                console.log('[oa] 未能从页面提取密钥。已扫描 '+diag.scanned.length+' 个资源('+secs+'s)：');
                diag.scanned.forEach(function(s){ console.log('  · '+s.url+' ('+s.len+'字符)'); });
                console.log('[oa] 提取到候选 '+diag.candidates.length+' 个'+(diag.candidatesCapped?'（已达上限，可能截断）':'')+'，组合成 '+diag.tried+' 组尝试，均未命中已知令牌。');
                console.log('[oa] 可重试：在控制台执行 window.oaCnipaFindKey()，或检查候选列表 window.oaCnipaDiag.candidates。');
                window.oaCnipaDiag=diag;
                return null;
            })
            .then(function(c){ window.__oaDetailCryptoBusy=null; return c; })
            .catch(function(e){
                window.__oaDetailCryptoBusy=null;
                console.log('[oa] 密钥发现异常: '+(e&&e.message||e));
                window.oaCnipaDiag=diag;
                return null;
            });
        return window.__oaDetailCryptoBusy;
    }
    // 手动触发密钥发现（失败后清 localStorage 缓存再跑一次，或调整页面后重试）
    window.oaCnipaFindKey=function(){
        try{ localStorage.removeItem('oa_cnipa_detail_crypto'); }catch(e){}
        detailCrypto=null;
        return discoverCryptoKey().then(function(c){
            console.log(c ? '[oa] 手动发现成功: '+JSON.stringify({algo:c.algo,keyB64:bytesToB64(c.key)}) : '[oa] 手动发现仍未命中');
            return c;
        });
    };
    function genDetailToken(appNo){
        var block=pkcs7PadBytes(strToBytes(appNo));
        var enc=(detailCrypto.algo==='aes')?aesEcbEncrypt(detailCrypto.key,block):sm4EcbEncrypt(detailCrypto.key,block);
        return enc.then(function(ct){ return bytesToB64(ct); });
    }
    // 搜索接口重试（缓解反爬/限流导致的偶发失败；登录态过期不重试）
    function searchApiWithRetry(payload, times, baseDelay){
        var t=times||3;
        return new Promise(function(resolve,reject){
            function attempt(n){
                searchApi(payload).then(resolve).catch(function(e){
                    if(/登录态过期|重定向|请登录/i.test(e.message||'')){ reject(e); return; }
                    if(n>=t){ reject(e); return; }
                    setTimeout(function(){ attempt(n+1); }, (baseDelay||700)*n);
                });
            }
            attempt(1);
        });
    }
    function openDetail(appNo){
        var key = clean(appNo).toUpperCase().replace(/[^0-9X]/g,'');
        if(!key){ return; }
        if(detailTokenCache[key]){ window.open(buildDetailUrl(detailTokenCache[key]), '_blank'); return; }
        var cached = scanRowsToken(key);
        if(cached){ detailTokenCache[key] = cached; window.open(buildDetailUrl(cached), '_blank'); return; }
        // 先同步开一个空白标签页（避免异步拿到令牌后才 open 被浏览器弹窗拦截），令牌就绪后在同一页跳转
        var w = window.open('', '_blank');
        var diag = { searchError:'', respKeys:'' };
        var fail = function(){
            setProgress('', false);
            if(w) w.close();
            var u=(location && location.origin) ? location.origin : 'https://cpquery.cponline.cnipa.gov.cn';
            window.open(u + '/', '_blank');
            var msg='未能获取该专利的详情链接，已打开 CNIPA 首页，请手动搜索 '+key+' 并点「详情」。';
            if(diag.searchError) msg+='\n\n搜索失败：'+diag.searchError;
            if(diag.respKeys) msg+='\n\n返回字段：'+diag.respKeys;
            // 密钥发现跑过但仍失败时，把诊断入口告诉用户（控制台已打印扫描清单）
            if(window.oaCnipaDiag && window.oaCnipaDiag.scanned){
                msg+='\n\n已尝试从页面代码提取密钥但未命中（扫描 '+window.oaCnipaDiag.scanned.length+' 个资源、候选 '+window.oaCnipaDiag.candidates.length+' 个）。';
                msg+='\n请打开控制台查看 [oa] 开头的日志，或在控制台执行 window.oaCnipaFindKey() 重试。';
            }
            alert(msg);
        };
        var finish = function(token){
            setProgress('', false);
            detailTokenCache[key]=token;
            var u=buildDetailUrl(token);
            if(w) w.location.href=u;
            else alert('已生成详情链接（浏览器拦截了新窗口，请手动打开）：\n' + u);
        };
        setProgress('获取详情链接...', true);
        // 1) 已破解密钥 → 直接生成令牌（最可靠、最快、零额外请求）
        if(detailCrypto){
            setProgress('正在生成详情令牌...', true);
            genDetailToken(key).then(finish, fail);
            return;
        }
        // 2) 实时搜索并提取返回里的令牌（带重试，缓解偶发失败）
        var payload = buildSearchPayload('', '', '', '');
        payload.zhuanlisqh = key; payload.size = 5;
        searchApiWithRetry(payload, 3, 700).then(function(json){
            var token = extractTokenForAppNo(json, key);
            if(token){ finish(token); return; }
            diag.respKeys = firstResponseKeys(json, 12);
            // 3) 没找到令牌 → 尝试从页面代码里破解加密密钥
            setProgress('正在从页面提取令牌密钥...', true);
            discoverCryptoKey().then(function(c){
                if(c){ genDetailToken(key).then(finish, fail); }
                else{ fail(); }
            }, fail);
        }).catch(function(e){
            setProgress('', false);
            diag.searchError = (e && e.message) || String(e);
            // 3) 搜索失败 → 同样尝试破解密钥
            setProgress('正在从页面提取令牌密钥...', true);
            discoverCryptoKey().then(function(c){
                if(c){ genDetailToken(key).then(finish, fail); }
                else{ fail(); }
            }, fail);
        });
    }
    window.oaCnipaOpenDetail = openDetail;
    function renderPreview(){
        var t=document.getElementById('oa-cnipa-preview'); if(!t) return;
        clearSel();
        // 复选框列 + 序号列 + 操作列固定在最前（行勾选 / 序号参考 / 「详情」按钮），
        // 不参与「显示字段」勾选、不进 CSV 导出、不参与单元格复制；
        // 专利号单元格保持纯文本，避免复制时把「详情」两个字一起带进去
        var visible=[];
        rows.forEach(function(r,idx){ if(matchStatusFilter(r)) visible.push({row:r,idx:idx}); });
        var html='<thead><tr>'+
            '<th style="width:26px;text-align:center;"><input type="checkbox" id="oa-cnipa-check-all" title="全选/取消当前筛选结果" style="vertical-align:middle;cursor:pointer;"></th>'+
            '<th style="width:34px;text-align:center;">序号</th>'+
            '<th style="width:44px;text-align:center;">操作</th>'+
            selectedHeaders.map(function(h){return '<th>'+h+'</th>';}).join('')+
            '</tr></thead><tbody>';
        html+=visible.map(function(item, vi){
            var r=item.row;
            var cellHtml = '<td class="oa-cnipa-check"><input type="checkbox" class="oa-cnipa-chk" data-idx="'+item.idx+'" '+(r._checked?'checked':'')+' style="vertical-align:middle;cursor:pointer;"></td>';
            cellHtml += '<td class="oa-cnipa-no" title="序号">'+(vi+1)+'</td>';
            cellHtml += '<td class="oa-cnipa-op">'+(r['专利号'] ? '<a class="oa-cnipa-detail" href="javascript:void(0)" data-appno="'+esc(r['专利号'])+'" title="在新窗口打开 CNIPA 专利详情页">详情</a>' : '')+'</td>';
            cellHtml += selectedHeaders.map(function(h){
                var raw = r[h] || '';
                return '<td title="'+esc(raw)+'">'+esc(raw)+'</td>';
            }).join('');
            return '<tr>'+cellHtml+'</tr>';
        }).join('');
        html+='</tbody>'; t.innerHTML=html;
        // 表头全选：勾选/取消「当前筛选结果」里的全部行（只改勾选态，供「更新信息」使用；
        // 不再回写「查专利号框」——专利号框只归「开始查询」，两者各自独立、互不覆盖）
        var chkAll=document.getElementById('oa-cnipa-check-all');
        if(chkAll){
            var visRows = rows.filter(matchStatusFilter);
            chkAll.checked = visRows.length > 0 && visRows.every(function(r){ return !!r._checked; });
            chkAll.onchange=function(){
                var checked=chkAll.checked;
                rows.forEach(function(r){ if(matchStatusFilter(r)) r._checked=checked; });
                renderPreview();
            };
        }
    }
    function renderFieldSelector(){
        var box=document.getElementById('oa-cnipa-field-list'); if(!box) return;
        var html='';
        ALL_HEADERS.forEach(function(h){
            var checked = selectedHeaders.indexOf(h) > -1 ? 'checked' : '';
            html += '<label style="display:inline-flex;align-items:center;gap:4px;margin:2px 6px 2px 0;font-size:12px;white-space:nowrap;cursor:pointer;">'+
                '<input type="checkbox" value="'+esc(h)+'" '+checked+'>'+esc(h)+'</label>';
        });
        box.innerHTML=html;
        var inputs=box.querySelectorAll('input[type="checkbox"]');
        for(var i=0;i<inputs.length;i++){
            inputs[i].onchange=function(){
                var sel=[];
                box.querySelectorAll('input[type="checkbox"]:checked').forEach(function(cb){ sel.push(cb.value); });
                if(!sel.length){ this.checked=true; return; }
                selectedHeaders=sel;
                setSelectedHeaders(sel);
                renderPreview();
            };
        }
    }
    function esc(t){ return clean(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function start(){
        if(batchActive){ setProgress('已有批次在运行（开始查询/更新信息/失败重查），请等当前批次结束', false); return; }
        if(!authReadyOrPrompt('开始查询')) return;   // 登录/身份/环境 三盏灯未全绿 → 提示并中止
        coolReset();     // 新批次从快节奏开始（清掉上一批遗留的冷却状态；批次中撞 400 才重新进入冷却）
        diagReset('查询');
        // 开始查询 = 整表新建查询：只按专利号框里的号码查询，不理会下方勾选（增量补空白用「更新信息」按钮）
        var plan = planForHeaders(selectedHeaders);
        var input=document.getElementById('oa-cnipa-input');
        var ids=input.value.split(/[^0-9Xx]+/).map(function(v){return v.trim().toUpperCase();}).filter(function(v){return v.length>=6;});
        if(!ids.length){alert('请先在专利号框粘贴要查询的申请号/专利号；或点「搜索并查询」得到列表后，勾选行再点「更新信息」');return;}
        diag.batch = '新建查询 ' + ids.length + '件';
        beginBatch();          // 记录批次开始：总耗时计时
        rows=[];
        // 新查询重置专利状态筛选（回「全部」），保证查一条出现一条、条数与查询数一致，不被上次筛选残留挡掉
        resetStatusFilterUI();
        renderPreview();
        var i=0, doneCnt=0, active=0;
        function next(){
            // 按 QUERY_CONCURRENCY 并发补位：每完成一件就隔 QUERY_INTERVAL_MS 再启动下一件，仍保持「查一条出现一条」
            while(i < ids.length && active < QUERY_CONCURRENCY){
                var no = ids[i++]; active++;
                setProgress('查询中 '+doneCnt+'/'+ids.length+' 完成，剩 '+(ids.length-i)+' 件（并发 '+active+'）', true);
                (function(no){
                    queryOne(no, plan).then(function(results){
                        rows.push(buildRow(no, results));
                        renderPreview();
                        doneCnt++; active--;
                        if(active === 0 && doneCnt >= ids.length){ doRetries(0); return; }
                        setTimeout(next, paceDelay());
                    });
                })(no);
            }
        }
        // 失败重试：查完后只重试失败行，最多 3 轮（SuperEngine「失败重试3轮只重查失败接口」同构）
        function doRetries(round){
            var failedRows = [];
            rows.forEach(function(r, idx){ if((r._failedKeys||[]).length) failedRows.push({row:r, no:r['专利号'], idx:idx}); });
            if(!failedRows.length){ endBatch(); setProgress('完成，共 '+rows.length+' 条，全部成功，总耗时 '+fmtElapsed(), false); return; }
            if(round >= 3){ endBatch(); setProgress('完成，共 '+rows.length+' 条，'+failedRows.length+' 条失败（已重试3次），总耗时 '+fmtElapsed(), false); renderPreview(); return; }
            setProgress('第 '+(round+1)+' 次重试失败项，共 '+failedRows.length+' 条...', true);
            var j=0;
            function retryNext(){
                if(j>=failedRows.length){ doRetries(round+1); return; }
                var item=failedRows[j];
                retryRow(item.row, item.no).then(function(){
                    rows[item.idx]=item.row; renderPreview();
                    j++; setTimeout(retryNext, 3000 + Math.random()*2000);
                });
            }
            retryNext();
        }
        next();
    }
    // 「更新信息」：把下方勾选的专利做空白字段增量补全——只访问「已勾选且仍空白」字段所需的接口，
    // 已有数据的字段不重查、不覆盖；当前有专利状态筛选时保持筛选不变（不清空、不改展示范围）；不访问没必要的接口
    function updateInfo(){
        if(batchActive){ setProgress('已有批次在运行（开始查询/更新信息/失败重查），请等当前批次结束', false); return; }
        coolReset();     // 新批次从快节奏开始（清掉上一批遗留的冷却状态；批次中撞 400 才重新进入冷却）
        diagReset('更新信息');
        if(!rows.length){ alert('当前没有结果。请先点「开始查询」，或用上方条件「搜索并查询」后勾选要更新的行'); return; }
        var plan = planForHeaders(selectedHeaders);
        var checked=[];
        rows.forEach(function(r,idx){ if(r._checked) checked.push({row:r, idx:idx}); });
        if(!checked.length){ alert('请先在下方面板勾选要更新的专利（可全选）'); return; }
        var todo=[];
        checked.forEach(function(c){
            var needed = rowNeededApis(c.row, selectedHeaders);
            if(!needed.length) return;
            todo.push({row:c.row, idx:c.idx, needed:needed});
        });
        if(!todo.length){ setProgress('所选专利所需字段均已齐全，无需重复补查', false); return; }
        startEnhance(todo, plan);
    }
    // 「更新信息」执行体：以当前结果（搜索/查询出的）为底表，只对勾选的行逐条补「空白字段」，其余行原样保留；
    // 与「开始查询」不同：本路径不清空专利状态筛选、不整表重建
    function startEnhance(todo, plan){
        var total=todo.length;
        if(!total){ return; }
        diag.batch = '更新信息 ' + total + '件';
        beginBatch();
        renderPreview();
        setProgress('更新信息 0/'+total+'（其余 '+rows.length+' 条保持不变，状态筛选不变）', true);
        var i=0, doneCnt=0, active=0;
        function next(){
            while(i < todo.length && active < QUERY_CONCURRENCY){
                var it = todo[i++]; active++;
                (function(idx, row, needed){
                    var no = row['专利号'];
                    // 只查这行「空白字段需要」的接口：缺什么才访问什么；取到后仅填空，已有数据绝不覆盖
                    var itemPlan = {}; API_KEYS.forEach(function(k){ itemPlan[k]=false; });
                    needed.forEach(function(k){ itemPlan[k]=true; });
                    queryOne(no, itemPlan).then(function(results){
                        fillRowBlanks(row, no, results, needed);  // 仅填空：搜索行预填值/已有数据原样保留
                        row._checked = true;                      // 更新后仍保持勾选，方便再选其他行继续更新
                        rows[idx] = row;                          // 原地替换，不删其他行
                        doneCnt++; active--;
                        renderPreview();
                        setProgress('更新信息 '+doneCnt+'/'+total+'（其余 '+rows.length+' 条保持不变，状态筛选不变）', doneCnt < total);
                        if(active === 0 && doneCnt >= total){ enhanceRetries(0, total); return; }
                        setTimeout(next, paceDelay());
                    });
                })(it.idx, it.row, it.needed);
            }
        }
        // 失败重试：只重试「本次更新批次内」失败的勾选行，最多 3 轮（SuperEngine「失败重试3轮」同构）；
        // 表中其他行（含历史失败、本次未勾选）一律不动，不访问没必要接口
        function enhanceRetries(round, total){
            var failedRows = [];
            todo.forEach(function(t){
                if((t.row._failedKeys||[]).length) failedRows.push({row:t.row, no:t.row['专利号'], idx:t.idx});
            });
            if(!failedRows.length){ endBatch(); setProgress('更新完成：'+total+' 条全部成功，其余 '+rows.length+' 条保持不变，总耗时 '+fmtElapsed(), false); renderPreview(); return; }
            if(round >= 3){ endBatch(); setProgress('更新完成：'+total+' 条，'+failedRows.length+' 条失败（已重试3次），其余 '+rows.length+' 条保持不变，总耗时 '+fmtElapsed(), false); renderPreview(); return; }
            setProgress('更新第 '+(round+1)+' 轮重试失败项，共 '+failedRows.length+' 条...', true);
            var j=0;
            function retryNext(){
                if(j>=failedRows.length){ enhanceRetries(round+1, total); return; }
                var item=failedRows[j];
                retryRow(item.row, item.no).then(function(){
                    rows[item.idx]=item.row; renderPreview();
                    j++; setTimeout(retryNext, 3000 + Math.random()*2000);
                });
            }
            retryNext();
        }
        next();
    }
    function exportXlsx(){
        var dispRows=visibleRows();
        if(!dispRows.length){alert('没有数据');return;}
        // 只导出勾选的字段列（与「显示字段」一致；没勾的可选接口根本没查，导不出内容）
        var headers=selectedHeaders;
        var aoa=[headers].concat(dispRows.map(function(r){return headers.map(function(h){return r[h]||'';});}));
        var csv='﻿'+aoa.map(function(c){return c.map(function(x){return '"'+String(x).replace(/"/g,'""')+'"';}).join(',');}).join('\r\n');
        var blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
        var link=document.createElement('a'); link.href=URL.createObjectURL(blob); link.download='CNIPA专利查询.csv';
        document.body.appendChild(link); link.click(); link.remove();
    }

    // ===== Excel 风格：点击/拖拽选中单元格，Ctrl+C 复制（多行多列按制表符/换行，像 Excel）=====
    var selStart=null, selEnd=null;
    function clearSel(){ selStart=null; selEnd=null; var sels=document.querySelectorAll('#oa-cnipa-preview td.selected'); for(var i=0;i<sels.length;i++) sels[i].classList.remove('selected'); }
    function isHeadCell(td){ var tr=td.parentNode; return !!(tr && tr.parentNode && tr.parentNode.tagName==='THEAD'); }
    // 控制列（操作「详情」/勾选框/序号）：不参与单元格选择与复制
    function isCtrlCell(td){ return !!(td && td.classList && (td.classList.contains('oa-cnipa-op') || td.classList.contains('oa-cnipa-check') || td.classList.contains('oa-cnipa-no'))); }
    function applySel(){
        var sels=document.querySelectorAll('#oa-cnipa-preview td'); for(var i=0;i<sels.length;i++) sels[i].classList.remove('selected');
        if(!selStart||!selEnd) return;
        var r1=Math.min(selStart.r,selEnd.r), r2=Math.max(selStart.r,selEnd.r);
        var c1=Math.min(selStart.c,selEnd.c), c2=Math.max(selStart.c,selEnd.c);
        var tbody=document.querySelector('#oa-cnipa-preview tbody'); if(!tbody) return;
        var trs=tbody.rows;
        for(var r=r1;r<=r2&&r<trs.length;r++){ var cells=trs[r].cells; for(var c=c1;c<=c2&&c<cells.length;c++) cells[c].classList.add('selected'); }
    }
    function selText(){
        if(!selStart||!selEnd) return '';
        var r1=Math.min(selStart.r,selEnd.r), r2=Math.max(selStart.r,selEnd.r);
        var c1=Math.min(selStart.c,selEnd.c), c2=Math.max(selStart.c,selEnd.c);
        var tbody=document.querySelector('#oa-cnipa-preview tbody'); if(!tbody) return '';
        var trs=tbody.rows, lines=[];
        for(var r=r1;r<=r2&&r<trs.length;r++){ var cells=trs[r].cells, arr=[]; for(var c=c1;c<=c2&&c<cells.length;c++){ if(isCtrlCell(cells[c])) continue; arr.push(cells[c].textContent); } lines.push(arr.join('\t')); }
        return lines.join('\n');
    }
    function initCellSelect(){
        var table=document.getElementById('oa-cnipa-preview');
        // 点「详情」链接：委托到表格上的 click 处理，打开真实 CNIPA 详情页（避免内联 onclick 被 CSP 拦）
        table.addEventListener('click', function(e){
            var a=e.target && e.target.closest ? e.target.closest('a.oa-cnipa-detail') : null;
            if(!a) return;
            e.preventDefault();
            openDetail(a.getAttribute('data-appno') || '');
        });
        // 行复选框 change：委托到表格（renderPreview 会重建单元格，委托在 table 上最稳）
        table.addEventListener('change', function(e){
            var cb=e.target;
            if(cb && cb.classList && cb.classList.contains('oa-cnipa-chk')){
                var idx=Number(cb.getAttribute('data-idx'));
                if(idx>=0 && idx<rows.length) rows[idx]._checked=!!cb.checked;
                // 只改勾选态（供「更新信息」用）；不回写「查专利号框」。实时刷新表头全选勾选态
                var allEl=document.getElementById('oa-cnipa-check-all');
                if(allEl){
                    var vis=rows.filter(matchStatusFilter);
                    allEl.checked = vis.length > 0 && vis.every(function(r){ return !!r._checked; });
                }
            }
        });
        table.addEventListener('mousedown', function(e){
            var td=e.target && e.target.closest ? e.target.closest('td') : null;
            if(!td){ return; }
            if(isHeadCell(td)){ clearSel(); return; }
            // 点「详情」链接：不进入单元格选择，交给浏览器默认行为开新窗口
            if(e.target && e.target.closest && e.target.closest('a.oa-cnipa-detail')){ return; }
            // 控制列（操作/复选框/序号）不可选：详情按钮不进选择、复选框保留默认点击；避免复制时把「详情」/勾选框/序号带进剪贴板
            if(isCtrlCell(td)){ clearSel(); return; }
            e.preventDefault();
            var r=td.parentNode.rowIndex-1, c=td.cellIndex;
            if(e.shiftKey && selStart){ selEnd={r:r,c:c}; }
            else { selStart={r:r,c:c}; selEnd={r:r,c:c}; }
            applySel();
        });
        table.addEventListener('mouseover', function(e){
            if(!selStart || !(e.buttons&1)) return;
            var td=e.target && e.target.closest ? e.target.closest('td') : null;
            if(!td || isHeadCell(td) || isCtrlCell(td)) return;
            selEnd={r:td.parentNode.rowIndex-1, c:td.cellIndex}; applySel();
        });
        document.addEventListener('copy', function(e){
            var text=selText();
            if(text && selStart){ if(e.clipboardData){ e.clipboardData.setData('text/plain', text); e.preventDefault(); } }
        });
        document.addEventListener('mousedown', function(e){
            var t=e.target;
            if(t && t.closest && !t.closest('#oa-cnipa-preview')) clearSel();
        });
    }

    // ===== 失败重查：将查询失败的按顺序重新查 3 遍 =====
    function manualRetry(){
        if(batchActive){ setProgress('已有批次在运行（开始查询/更新信息/失败重查），请等当前批次结束', false); return; }
        diagReset('失败重查');
        var failedRows=[];
        rows.forEach(function(r,idx){ if((r._failedKeys||[]).length) failedRows.push({row:r,no:r['专利号'],idx:idx}); });
        if(!failedRows.length){ alert('没有失败项'); setProgress('没有失败项，无需重查', false); return; }
        diag.batch = '失败重查 ' + failedRows.length + '条';
        beginBatch();
        setProgress('失败重查：共 '+failedRows.length+' 条，按顺序查3遍...', true);
        var round=0;
        function roundNext(){
            var still=[];
            rows.forEach(function(r,idx){ if((r._failedKeys||[]).length) still.push({row:r,no:r['专利号'],idx:idx}); });
            if(!still.length){ endBatch(); setProgress('失败重查完成：全部成功（共 '+rows.length+' 条），总耗时 '+fmtElapsed(), false); renderPreview(); return; }
            if(round>=3){ endBatch(); setProgress('失败重查完成：共 '+rows.length+' 条，仍有 '+still.length+' 条失败（已查3遍），总耗时 '+fmtElapsed(), false); renderPreview(); return; }
            round++;
            setProgress('失败重查 第'+round+'/3 遍：剩余 '+still.length+' 条...', true);
            var k=0;
            function inner(){
                if(k>=still.length){ renderPreview(); roundNext(); return; }
                var it=still[k];
                retryRow(it.row, it.no).then(function(){
                    rows[it.idx]=it.row; renderPreview();
                    k++; setTimeout(inner, 3000+Math.random()*2000);
                });
            }
            inner();
        }
        roundNext();
    }

    // ===== 专利状态筛选（多选，作用于当前结果展示与导出）=====
    // statusFilter 为空数组 = 不过滤（显示全部）；已选中的状态按「案件状态」精确匹配
    var statusFilter = [];
    function matchStatusFilter(r){ return statusFilter.length === 0 || statusFilter.indexOf(r['案件状态'] || '') > -1; }
    function visibleRows(){ return rows.filter(matchStatusFilter); }
    // 当前 rows 里实际出现过的案件状态（去重排序），作为多选框候选项
    function distinctStatuses(){
        var map = {};
        rows.forEach(function (r) { var s = r['案件状态'] || ''; if (s) map[s] = true; });
        return Object.keys(map).sort();
    }
    function resetStatusFilterUI(){ statusFilter = []; if (typeof updateStatusBtn === 'function') updateStatusBtn(); }

    // ===== 按条件搜索（申请人/专利类型/申请日）→ 取申请号列表 → 批量查详情 =====
    // 请求体字段名与 CNIPA publicSearch 真实 fetch 一致：
    //   zhuanlilx=专利类型(1发明/2实用新型/3外观设计), shenqingrxm=申请人,
    //   shenqingrStart/End=申请日范围, page=页, size=每页条数（默认 50，UI 可选 100/200/500）
    // 注意：size 与 400 无关（400 的根因是 URL 带 hHp4Kgam 参数/请求头带 hhp4kgam，
    // 真实前端 publicSearch 两者都不带）；若大 size 被后端拒或截断，按实际返回条数展示。
    function currentSearchSize(){
        var el=document.getElementById('oa-cnipa-size');
        var v = el ? parseInt(el.value, 10) : 50;
        return (v === 100 || v === 200 || v === 500) ? v : 50;
    }
    function buildSearchPayload(applicant, type, dateFrom, dateTo) {
        return {
            zhuanlilx: type || '',
            page: 1,
            size: currentSearchSize(),
            sortDataName: '',
            sortType: '',
            shenqingrxm: applicant || '',
            shenqingrStart: dateFrom || '',
            shenqingrEnd: dateTo || ''
        };
    }
    function searchApi(payload) {
        var headers = {'Content-Type':'application/json;charset=UTF-8','Accept':'application/json, text/plain, */*','Authorization':auth.authorization};
        if (auth.userType) headers.userType = auth.userType;
        var url = '/api/search/undomestic/publicSearch';
        diagTry();
        return pacedNet(function(){ return postJsonFetch(url, headers, payload); }).catch(function(e){
            var em = e && e.message ? e.message : String(e);
            diagErr(/超时|timeout/i.test(em) ? '搜索:网络超时' : '搜索:网络错误');
            throw e;
        }).then(function(resp){
            if (resp.status === 401) { auth.authorization=''; diagErr('搜索:401登录态过期', resp.status); throw new Error('登录态过期'); }
            if (isThrottleStatus(resp.status)) { triggerCool(); diagErr('搜索:HTTP'+resp.status+'限流', resp.status); }
            return resp.text.then(function(t){
                var json; try { json = JSON.parse(t); }
                catch (e) { diagErr('搜索:HTTP'+resp.status+'非JSON', resp.status); if (/<html|<body|用户名|密码|请登录/i.test(t)) { throw new Error('登录态过期，被重定向到登录页'); } throw new Error('搜索响应非JSON（HTTP ' + resp.status + '）：' + String(t||'').slice(0,200)); }
                if (json.code !== 200) { diagErr('搜索:业务code!=200', null, json.code); throw new Error('搜索失败 code=' + json.code + (json.msg ? '（' + json.msg + '）' : '')); }
                diagOk();
                return json;
            });
        });
    }
    // 递归提取搜索响应里的申请号（键名含 zhuanlisqh/shenqingh 等，或纯 9-13 位数字串）
    function extractAppNos(data) {
        var out = [], seen = [], stack = [data];
        var keyRe = /zhuanlisqh|shenqingh|shenqinghao|appNo|applicationNumber/i;
        while (stack.length) {
            var item = stack.shift();
            if (!item || typeof item !== 'object' || seen.indexOf(item) > -1) continue;
            seen.push(item);
            if (Array.isArray(item)) { item.forEach(function (c) { stack.push(c); }); continue; }
            Object.keys(item).forEach(function (k) {
                var v = item[k];
                if (keyRe.test(k)) {
                    var s = clean(v).toUpperCase().replace(/[^0-9X]/g, '');
                    if (/^[0-9X]{8,13}$/.test(s) && out.indexOf(s) === -1) out.push(s);
                }
                if (typeof v === 'string') {
                    var s2 = clean(v);
                    // 申请号是 13 位纯数字，避免把计数/页大小等数字误当申请号
                    if (/^\d{13}$/.test(s2) && out.indexOf(s2) === -1) out.push(s2);
                }
                if (v && typeof v === 'object') stack.push(v);
            });
        }
        return out;
    }
    // 搜索响应里 zhuanlilx 是代码（1发明/2实用新型/3外观设计），转成展示文案
    function searchTypeToText(code) {
        code = clean(code || '');
        if (code === '1') return '发明';
        if (code === '2') return '实用新型';
        if (code === '3') return '外观设计';
        return code;
    }
    // 把搜索接口返回的 records 直接映射成表格行（专利号/名称/类型/申请日/案件状态/申请人），
    // 搜索响应里的 total 字段（该公司共有多少件专利，与本次加载条数无关）；兼容两种嵌套
    function extractSearchTotal(json) {
        var data = json && json.data ? json.data : null;
        if (!data) return 0;
        var n;
        if (typeof data.total === 'number') n = data.total;
        else if (data.data && typeof data.data.total === 'number') n = data.data.total;
        else n = parseInt((data.data && data.data.total) || data.total || '', 10);
        return isNaN(n) ? 0 : n;
    }
    // 搜索响应本身已含这些字段，无需逐个调详情接口；费用/质押等富字段留空，勾选行后点「更新信息」只补空白字段
    function parseSearchRows(json) {
        var out = [];
        // 兼容两种响应嵌套：data.records（部分接口）与 data.data.records（publicSearch 真实结构，已从 chunk 7 实证）
        var data = json && json.data ? json.data : null;
        var records = null;
        if (data) {
            if (Array.isArray(data.records)) records = data.records;
            else if (data.data && Array.isArray(data.data.records)) records = data.data.records;
        }
        if (!records) return out;
        records.forEach(function (rec) {
            if (!rec || typeof rec !== 'object') return;
            var no = clean(rec.zhuanlisqh || rec.zhuanlisq || rec.shenqingh || '').toUpperCase().replace(/[^0-9X]/g, '');
            if (!no) return;
            var row = {};
            row['专利号'] = no;
            row['专利名称'] = clean(rec.zhuanlimc || rec.famingmc || rec.mingcheng || '');
            row['专利类型'] = searchTypeToText(rec.zhuanlilx);
            row['申请日'] = formatDate(rec.shenqingr || rec.shenqingrq || '');
            row['案件状态'] = clean(rec.anjianywzt || rec.anjianzt || '');
            row['申请人'] = clean(rec.shenqingrxm || rec.shenqingren || rec.sqrmc || '');
            row._failedKeys = [];
            row._fromSearch = true;
            // 搜索出来的专利默认全选：勾选行后点「更新信息」只补空白字段（不重查已有数据），可先勾掉不需要的再点
            row._checked = true;
            out.push(row);
        });
        return out;
    }
    function searchPatents() {
        if(batchActive){ setProgress('已有批次在运行（开始查询/更新信息/失败重查），请等当前批次结束', false); return; }
        var applicant = clean(document.getElementById('oa-cnipa-applicant').value);
        var type = document.getElementById('oa-cnipa-type').value;
        var dateFrom = document.getElementById('oa-cnipa-appdate-from').value;
        var dateTo = document.getElementById('oa-cnipa-appdate-to').value;
        var hint = document.getElementById('oa-cnipa-search-hint');
        if (!applicant && !type && !dateFrom && !dateTo) { if (hint) hint.style.display = ''; return; }
        if (hint) hint.style.display = 'none';
        if(!authReadyOrPrompt('搜索并查询')) return;   // 登录/身份/环境 三盏灯未全绿 → 提示并中止
        var payload = buildSearchPayload(applicant, type, dateFrom, dateTo);
        setProgress('搜索中...', true);
        searchApi(payload).then(function (json) {
            if (json === null) return;
            var newRows = parseSearchRows(json);
            var total = extractSearchTotal(json);
            if (!newRows.length) { setProgress('搜索完成：该公司共 ' + (total || '?') + ' 件专利，本页未匹配到数据', false); return; }
            // 输入框填入这批申请号（点「开始查询」即整批重查这批号）；搜索出的行默认全选，点「更新信息」只补空白字段
            document.getElementById('oa-cnipa-input').value = newRows.map(function (r) { return r['专利号']; }).join('\n');
            rows = newRows;
            resetStatusFilterUI();
            renderPreview();
            setProgress('搜索完成：该公司共 ' + (total || '?') + ' 件专利，已加载并默认全选 ' + newRows.length + ' 条（点「更新信息」补费用/质押等空白字段，已有数据不重查）', false);
        }).catch(function (e) { setProgress('搜索失败：' + (e.message || e), false); });
    }

    var s=document.createElement('style');
    s.textContent='#oa-cnipa-panel{position:fixed;right:16px;top:76px;z-index:999999;width:760px;max-height:calc(100vh - 100px);background:#fff;border:1px solid #b9c6dd;box-shadow:0 8px 28px rgba(0,0,0,.2);font:14px/1.5 Arial,"Microsoft YaHei",sans-serif;overflow:auto;border-radius:8px;}'+
        '#oa-cnipa-head{background:#3664d1;color:#fff;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;font-size:16px;cursor:move;}'+
        '#oa-cnipa-body{padding:12px;}'+
        '#oa-cnipa-input{width:100%;height:80px;border:1px solid #ccc;padding:6px;font:13px/1.4 Consolas,monospace;box-sizing:border-box;}'+
        '#oa-cnipa-search{margin:8px 0;padding:8px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;}'+
        '#oa-cnipa-search .lbl{display:inline-flex;align-items:center;gap:4px;margin-right:10px;font-size:13px;white-space:nowrap;}'+
        '#oa-cnipa-search input[type=text],#oa-cnipa-search input[type=date],#oa-cnipa-search select{border:1px solid #cbd5e1;border-radius:4px;padding:3px 6px;font-size:13px;}'+
        '#oa-cnipa-panel button#oa-cnipa-status-btn{border:1px solid #cbd5e1;border-radius:4px;padding:3px 8px;font-size:13px;background:#fff;cursor:pointer;color:#334155;margin:0;}'+
        '#oa-cnipa-status-pop label{display:flex;align-items:center;gap:4px;white-space:nowrap;font-size:12px;cursor:pointer;padding:2px 4px;border-radius:3px;}'+
        '#oa-cnipa-status-pop label:hover{background:#f1f5f9;}'+
        '#oa-cnipa-status-pop a{text-decoration:none;font-size:12px;}'+
        '#oa-cnipa-preview a.oa-cnipa-detail{color:#244fc0;text-decoration:none;border:1px solid #244fc0;border-radius:3px;padding:0 4px;font-size:11px;margin-left:4px;white-space:nowrap;}'+
        '#oa-cnipa-preview a.oa-cnipa-detail:hover{background:#244fc0;color:#fff;}'+
        '#oa-cnipa-panel button{border:1px solid #3664d1;background:#fff;color:#244fc0;border-radius:4px;padding:6px 12px;margin:6px 6px 0 0;cursor:pointer;}'+
        '#oa-cnipa-panel button.primary{background:#3664d1;color:#fff;}'+
        '#oa-cnipa-status{margin:8px 0;font-size:13px;color:#555;}'+
        '#oa-cnipa-status .ok{color:#047857;}'+
        '#oa-cnipa-status .bad{color:#b91c1c;}'+
        '#oa-cnipa-preview-wrap{overflow:auto;border:1px solid #e2e8f0;margin-top:8px;max-height:400px;}'+
        '#oa-cnipa-preview{width:100%;border-collapse:collapse;font-size:12px;}'+
        '#oa-cnipa-preview th,#oa-cnipa-preview td{border:1px solid #e2e8f0;padding:4px;white-space:nowrap;max-width:150px;overflow:hidden;text-overflow:ellipsis;}'+
        '#oa-cnipa-preview td{cursor:cell;-webkit-user-select:none;user-select:none;}'+
        '#oa-cnipa-preview td.oa-cnipa-op,#oa-cnipa-preview td.oa-cnipa-check,#oa-cnipa-preview td.oa-cnipa-no{cursor:default;text-align:center;}'+
        '#oa-cnipa-preview td.oa-cnipa-no{color:#94a3b8;font-size:11px;}'+
        '#oa-cnipa-preview td.selected{background:#bfdbfe;outline:2px solid #3664d1;outline-offset:-2px;}'+
        '#oa-cnipa-preview th{background:#f8fafc;position:sticky;top:0;}'+
        '#oa-cnipa-resize{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;background:linear-gradient(135deg,transparent 50%,#999 50%);}'+
        '#oa-cnipa-head .head-btn{cursor:pointer;padding:0 6px;font-size:16px;line-height:1;margin-left:8px;}'+
        '#oa-cnipa-spinner{display:none;width:14px;height:14px;border:2px solid #cbd5e1;border-top-color:#3664d1;border-radius:50%;animation:oa-cnipa-spin 0.7s linear infinite;vertical-align:middle;margin-right:6px;}'+
        '@keyframes oa-cnipa-spin{to{transform:rotate(360deg);}}';
    document.documentElement.appendChild(s);

    var panel=document.createElement('div');
    panel.id='oa-cnipa-panel';
    panel.innerHTML='<div id="oa-cnipa-head"><b>CNIPA 批量查询</b><span><span id="oa-cnipa-max" class="head-btn" title="最大化/还原">□</span><span id="oa-cnipa-close" class="head-btn" title="关闭">×</span></span></div>'+
        '<div id="oa-cnipa-body"><div id="oa-cnipa-status"></div>'+
        '<div id="oa-cnipa-search"><div style="font-weight:700;color:#334155;margin-bottom:6px;">按条件查询</div>'+
        '<div style="display:flex;flex-wrap:wrap;align-items:center;">'+
        '<span class="lbl">申请人 <input type="text" id="oa-cnipa-applicant" placeholder="企业/个人名称"></span>'+
        '<span class="lbl">专利类型 <select id="oa-cnipa-type"><option value="">全部</option><option value="1">发明</option><option value="2">实用新型</option><option value="3">外观设计</option></select></span>'+
        '<span class="lbl">申请日 <input type="date" id="oa-cnipa-appdate-from"> ~ <input type="date" id="oa-cnipa-appdate-to"></span>'+
        '<span class="lbl">每页 <select id="oa-cnipa-size"><option value="50" selected>50</option><option value="100">100</option><option value="200">200</option><option value="500">500</option></select> 条</span>'+
        '<button id="oa-cnipa-search" class="primary">搜索并查询</button>'+
        '</div>'+
        '<div id="oa-cnipa-search-hint" style="display:none;color:#b91c1c;font-size:12px;margin-top:4px;">请至少填一个查询条件（申请人/专利类型/申请日）</div>'+
        '</div>'+
        '<textarea id="oa-cnipa-input" placeholder="每行一个申请号/专利号；或用上方条件搜索"></textarea>'+
        '<div><button id="oa-cnipa-start" class="primary">开始查询</button><button id="oa-cnipa-update">更新信息</button><button id="oa-cnipa-export">导出CSV</button><button id="oa-cnipa-fail-retry">失败重查</button><button id="oa-cnipa-clear">清空</button></div>'+
        '<div id="oa-cnipa-fields" style="margin:8px 0;padding:8px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;">'+
        '<div id="oa-cnipa-fields-head" style="cursor:pointer;user-select:none;font-weight:700;color:#334155;"><span id="oa-cnipa-fields-toggle">-</span> 显示字段 <span style="color:#64748b;font-weight:400;font-size:12px;">（勾选要显示的列）</span></div>'+
        '<div id="oa-cnipa-field-list" style="margin-top:6px;"></div>'+
        '</div>'+
        '<div id="oa-cnipa-progress"><span id="oa-cnipa-spinner"></span><span id="oa-cnipa-progress-text">等待输入</span></div>'+
        '<div style="display:flex;align-items:center;gap:8px;margin:8px 0 4px;font-size:13px;color:#334155;">'+
        '<span style="position:relative;display:inline-block;">'+
        '<button id="oa-cnipa-status-btn" type="button">专利状态筛选：全部</button>'+
        '<div id="oa-cnipa-status-pop" style="display:none;position:absolute;top:calc(100% + 3px);left:0;background:#fff;border:1px solid #cbd5e1;border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,.16);padding:6px;z-index:30;max-height:260px;overflow:auto;min-width:210px;"></div>'+
        '</span>'+
        '<span style="color:#94a3b8;font-size:11px;">仅影响当前结果展示与导出（可多选）</span>'+
        '</div>'+
        '<div id="oa-cnipa-preview-wrap"><table id="oa-cnipa-preview"></table></div>'+
        '<div style="font-size:11px;color:#94a3b8;margin-top:2px;">💡 点击/拖拽选中单元格（Shift+点击可扩展），Ctrl+C 按表格格式复制（多行多列）；操作列的「详情」不参与复制</div>'+
        '</div>';
    document.body.appendChild(panel);

    // 添加右下角缩放手柄
    var resizeHandle=document.createElement('div');
    resizeHandle.id='oa-cnipa-resize';
    panel.appendChild(resizeHandle);

    // 最大化/还原（修复：第一次点击被头部拖拽 mousedown 拦截导致需点两次）
    var isMax=false, savedRect=null, maxBtn=document.getElementById('oa-cnipa-max');
    // 头部按钮的 mousedown 阻止冒泡，避免进入「拖动面板」逻辑
    [maxBtn, document.getElementById('oa-cnipa-close')].forEach(function(btn){
        btn.addEventListener('mousedown', function(e){ e.stopPropagation(); e.preventDefault(); });
    });
    maxBtn.onclick=function(){
        if(!isMax){
            var rect=panel.getBoundingClientRect();
            savedRect={left:rect.left, top:rect.top, width:panel.offsetWidth, height:panel.offsetHeight};
            panel.style.left='0'; panel.style.top='0'; panel.style.right='';
            panel.style.width='100vw'; panel.style.height='100vh';
            panel.style.maxHeight='none'; panel.style.maxWidth='none';
            isMax=true; maxBtn.textContent='❐';
        } else {
            panel.style.left=savedRect.left+'px'; panel.style.top=savedRect.top+'px'; panel.style.right='';
            panel.style.width=savedRect.width+'px'; panel.style.height=savedRect.height+'px';
            panel.style.maxHeight=''; panel.style.maxWidth='';
            isMax=false; maxBtn.textContent='□';
        }
    };

    // 拖动缩放手柄
    (function(){
        var sx=0, sy=0, sw=0, sh=0;
        resizeHandle.addEventListener('mousedown', function(e){
            e.stopPropagation(); e.preventDefault();
            isMax=false; if(maxBtn) maxBtn.textContent='□';
            sx=e.clientX; sy=e.clientY;
            sw=panel.offsetWidth; sh=panel.offsetHeight;
            panel.style.width=sw+'px'; panel.style.height=sh+'px';
            panel.style.maxHeight='none'; panel.style.maxWidth='none';
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up);
        });
        function move(e){
            panel.style.width=Math.max(360, sw+e.clientX-sx)+'px';
            panel.style.height=Math.max(200, sh+e.clientY-sy)+'px';
        }
        function up(){ document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); }
    })();

    renderFieldSelector();
    document.getElementById('oa-cnipa-fields-head').onclick=function(){
        var list=document.getElementById('oa-cnipa-field-list');
        var toggle=document.getElementById('oa-cnipa-fields-toggle');
        var hidden = list.style.display==='none';
        list.style.display = hidden ? '' : 'none';
        toggle.textContent = hidden ? '-' : '+';
    };
    document.getElementById('oa-cnipa-close').onclick=function(){panel.style.display='none';};
    document.getElementById('oa-cnipa-start').onclick=start;
    document.getElementById('oa-cnipa-update').onclick=updateInfo;
    document.getElementById('oa-cnipa-export').onclick=exportXlsx;
    document.getElementById('oa-cnipa-fail-retry').onclick=manualRetry;
    document.getElementById('oa-cnipa-clear').onclick=function(){
        rows=[]; resetStatusFilterUI();
        var inp=document.getElementById('oa-cnipa-input'); if(inp) inp.value='';
        renderPreview();
    };
    // 专利状态多选筛选：按钮开关 + 下拉多选框（选项来自当前 rows 实际出现的状态，支持多选）
    var sfBtn = document.getElementById('oa-cnipa-status-btn');
    var sfPop = document.getElementById('oa-cnipa-status-pop');
    function updateStatusBtn(){
        if(!sfBtn) return;
        var all = distinctStatuses();
        var isAll = all.length > 0 && statusFilter.length === all.length;
        if(!statusFilter.length || isAll) sfBtn.textContent = '专利状态筛选：全部';
        else sfBtn.textContent = '专利状态筛选：' + statusFilter.length + ' 项';
    }
    function statusOptHtml(){
        var opts = distinctStatuses();
        var html = '<div style="margin-bottom:4px;border-bottom:1px solid #e2e8f0;padding-bottom:4px;">'+
            '<a href="javascript:void(0)" id="oa-cnipa-status-all" style="margin-right:10px;">全选</a>'+
            '<a href="javascript:void(0)" id="oa-cnipa-status-clear" style="color:#b91c1c;">清空</a>'+
            '</div>';
        if(!opts.length) html += '<div style="color:#94a3b8;font-size:12px;padding:4px 2px;">（暂无数据）</div>';
        opts.forEach(function(s){
            html += '<label><input type="checkbox" value="' + esc(s) + '" ' + (statusFilter.indexOf(s) > -1 ? 'checked' : '') + '>' + esc(s) + '</label>';
        });
        return html;
    }
    // 状态筛选变化后的统一收口：被筛掉的行移出勾选集（杜绝「隐藏但勾选」的幽灵选中，
    // 免得「更新信息」误更新筛选外看不到的行）；「查专利号框」不受影响，只归「开始查询」
    function applyStatusFilterChange(){
        rows.forEach(function(r){ if(!matchStatusFilter(r)) r._checked=false; });
        updateStatusBtn();
        renderPreview();
    }
    function renderStatusPop(){ sfPop.innerHTML = statusOptHtml(); }
    function wireStatusPop(){
        sfPop.querySelectorAll('input[type="checkbox"]').forEach(function(cb){
            cb.onchange = function(){
                var v = cb.value, i = statusFilter.indexOf(v);
                if(cb.checked && i === -1) statusFilter.push(v);
                if(!cb.checked && i > -1) statusFilter.splice(i, 1);
                applyStatusFilterChange();
            };
        });
        var allEl = document.getElementById('oa-cnipa-status-all');
        if(allEl) allEl.onclick = function(){
            statusFilter = distinctStatuses();
            applyStatusFilterChange();
            renderStatusPop(); wireStatusPop();   // 重绘弹窗勾选态（保持打开），避免视觉与实际不符
        };
        var clearEl = document.getElementById('oa-cnipa-status-clear');
        if(clearEl) clearEl.onclick = function(){
            statusFilter = [];
            applyStatusFilterChange();
            renderStatusPop(); wireStatusPop();
        };
    }
    function openStatusPop(){ renderStatusPop(); wireStatusPop(); sfPop.style.display = ''; }
    sfBtn.onclick = function(){
        if(sfPop.style.display === 'none') openStatusPop();
        else sfPop.style.display = 'none';
    };
    document.addEventListener('mousedown', function(e){
        var t = e.target;
        if(sfPop.style.display !== 'none' && t && !sfPop.contains(t) && !sfBtn.contains(t)){
            sfPop.style.display = 'none';
        }
    });
    document.getElementById('oa-cnipa-search').onclick = searchPatents;
    setInterval(scanAuth,2000); scanAuth();
    initCellSelect();

    // 拖动面板
    (function makeDraggable(handle){
        var sx=0, sy=0, sl=0, st=0;
        handle.addEventListener('mousedown', function(e){
            // 点头部按钮（最大化/关闭）时不启动拖拽
            var t=e.target;
            if(t && (/head-btn/.test(t.className||'') || (t.closest && t.closest('.head-btn')))) return;
            sx=e.clientX; sy=e.clientY;
            var rect=panel.getBoundingClientRect();
            sl=rect.left; st=rect.top;
            panel.style.right='auto';
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up);
        });
        function move(e){ panel.style.left=Math.max(0, sl+e.clientX-sx)+'px'; panel.style.top=Math.max(0, st+e.clientY-sy)+'px'; }
        function up(){ document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); }
    })(document.getElementById('oa-cnipa-head'));

    alert('面板已注入！请先手动查询一个专利，等三项状态变绿后再批量查询。');
})();
