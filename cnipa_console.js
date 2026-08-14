// ===== 复制以下全部代码，粘贴到 CNIPA 官网 F12 Console 回车运行 =====
(function () {
    if (document.getElementById('oa-cnipa-panel')) { alert('面板已存在'); return; }

    // ===== 接口配置 =====
    var APIS = {
        sqxx:   { path: '/api/view/gn/sqxx',              label: '申请信息' },
        gbggxx: { path: '/api/view/gn/gbggxx',            label: '公告信息' },
        fyxx:   { path: '/api/view/gn/fyxx',              label: '费用信息' },
        zlqzyxx:{ path: '/api/view/gn/get-zlqzydjh-list', label: '质押信息' },
        ssxkba: { path: '/api/view/gn/get-ssxkbah-list',  label: '许可备案' }
    };
    var API_KEYS = Object.keys(APIS);
    // 全部字段（顺序）
    var ALL_HEADERS = ['专利号','专利名称','专利类型','申请人','费用种类','应缴金额','截止日期','代理所','质押状态','授权公告日','案件状态','法律状态','费用状态','最近缴费人','最近缴费种类','变更费','质押信息','许可备案信息'];
    // 默认显示字段
    var DEFAULT_HEADERS = ['专利号','专利名称','专利类型','申请人','应缴金额','截止日期','代理所','质押状态'];
    var STORAGE_KEY = 'oa_cnipa_headers';
    function getSelectedHeaders() {
        try {
            var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
            var f = Array.isArray(saved) ? saved.filter(function(h){ return ALL_HEADERS.indexOf(h) > -1; }) : [];
            if (f.length) return f;
        } catch(e) {}
        return DEFAULT_HEADERS.slice();
    }
    function setSelectedHeaders(headers) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(headers.filter(function(h){ return ALL_HEADERS.indexOf(h) > -1; }))); } catch(e) {}
    }
    var selectedHeaders = getSelectedHeaders();

    // ===== 认证状态 =====
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
        return {
            patentName: patentName, applicant: uniqueJoin(applicantNames), agency: uniqueJoin(agencyNames),
            patentType: inferPatentType(appNo, rawType, grantDate, caseStatus, legalStatus),
            grantDate: grantDate, caseStatus: caseStatus, legalStatus: legalStatus
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
    function callApi(apiKey, appNo) {
        if(!auth.authorization) return Promise.reject(new Error('未捕获Authorization'));
        var baseHeaders = {'Content-Type':'application/json;charset=utf-8','Accept':'application/json, text/plain, */*','Authorization':auth.authorization};
        if(auth.userType) baseHeaders.userType = auth.userType;
        var payload = buildApiPayload(apiKey, appNo);
        var attempts = [ function(){ return postJsonFetch(buildApiUrl(apiKey,false), baseHeaders, payload); } ];
        if(auth.hhp4kgam){
            var hhpHeaders = {}; Object.keys(baseHeaders).forEach(function(k){hhpHeaders[k]=baseHeaders[k];});
            hhpHeaders['Content-Type']='application/json;charset=UTF-8';
            hhpHeaders['Usertype']=auth.userType||''; hhpHeaders['Hhp4kgam']=auth.hhp4kgam;
            attempts.push(function(){ return postJsonXhr(buildApiUrl(apiKey,true), hhpHeaders, payload); });
        }
        var errors=[];
        return new Promise(function(resolve,reject){
            function tryNext(i){
                if(i>=attempts.length){ reject(new Error(APIS[apiKey].label+': '+errors.join('；'))); return; }
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

    // ===== 组装行 =====
    function buildRow(appNo, results) {
        var cleaned = clean(appNo).toUpperCase().replace(/[^0-9X]/g,'');
        var sq = results.sqxx && results.sqxx.ok ? parseSqxx(cleaned, results.sqxx.data) : {};
        var grantDate = parseGrantDateFromGbgg((results.gbggxx && results.gbggxx.ok) ? results.gbggxx.data : null) || sq.grantDate || '';
        var fee = results.fyxx && results.fyxx.ok ? parseFee(results.fyxx.data) : {};
        var pledge = results.zlqzyxx && results.zlqzyxx.ok ? parsePledge(results.zlqzyxx.data, results.sqxx && results.sqxx.ok ? results.sqxx.data : null) : {};
        var license = results.ssxkba && results.ssxkba.ok ? parseLicense(results.ssxkba.data) : {};
        var row = {};
        row['专利号']=cleaned;
        row['专利名称']=sq.patentName||'';
        row['申请人']=sq.applicant||'';
        row['代理所']=sq.agency||'';
        row['专利类型']=sq.patentType||'';
        row['授权公告日']=grantDate||'';
        row['案件状态']=sq.caseStatus||'';
        row['法律状态']=sq.legalStatus||'';
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
        return row;
    }

    function queryOne(no, plan) {
        var results={}, keys=API_KEYS.filter(function(k){return plan[k];});
        var chain=Promise.resolve();
        keys.forEach(function(k){ chain=chain.then(function(){ return callApi(k,no).then(function(d){results[k]={ok:true,data:d};}).catch(function(e){results[k]={ok:false,error:e.message};}); }); });
        return chain.then(function(){return results;});
    }

    // 重试单行的失败接口
    function retryRow(row, no) {
        var failedKeys = row._failedKeys || [];
        if(!failedKeys.length) return Promise.resolve();
        var plan = {}; API_KEYS.forEach(function(k){plan[k]=false;}); failedKeys.forEach(function(k){plan[k]=true;});
        return queryOne(no, plan).then(function(results){
            // 合并成功的结果到旧结果
            var merged = row._results || {};
            failedKeys.forEach(function(k){
                if(results[k] && results[k].ok){ merged[k] = results[k]; }
            });
            // 用合并结果重建行
            var newRow = buildRow(no, merged);
            // 保留专利号等原有字段（buildRow 会重建，直接替换）
            Object.keys(newRow).forEach(function(k){ row[k] = newRow[k]; });
            row._results = merged;
            row._failedKeys = API_KEYS.filter(function(k){return merged[k] && !merged[k].ok;});
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
    function renderPreview(){
        var t=document.getElementById('oa-cnipa-preview'); if(!t) return;
        var headers=selectedHeaders;
        var html='<thead><tr>'+headers.map(function(h){return '<th>'+h+'</th>';}).join('')+'</tr></thead><tbody>';
        html+=rows.map(function(r){return '<tr>'+headers.map(function(h){return '<td title="'+esc(r[h]||'')+'">'+esc(r[h]||'')+'</td>';}).join('')+'</tr>';}).join('');
        html+='</tbody>'; t.innerHTML=html;
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
        var input=document.getElementById('oa-cnipa-input');
        var ids=input.value.split(/[^0-9Xx]+/).map(function(v){return v.trim().toUpperCase();}).filter(function(v){return v.length>=6;});
        if(!ids.length){alert('请先粘贴申请号/专利号');return;}
        if(!isAuthReady()){alert('请先在页面手动查询一个专利，等三项状态都正常');return;}
        var plan={sqxx:true,gbggxx:true,fyxx:true,zlqzyxx:true,ssxkba:true};
        rows=[]; renderPreview();
        var i=0;
        function next(){
            if(i>=ids.length){ doRetries(0); return; }
            var no=ids[i]; setProgress('查询中 '+(i+1)+'/'+ids.length+'：'+no, true);
            queryOne(no,plan).then(function(results){ rows.push(buildRow(no,results)); renderPreview(); i++; setTimeout(next, 3000 + Math.random()*2000); });
        }
        // 失败重试：查完后重试失败项，再查一次失败项（共2轮）
        function doRetries(round){
            var failedRows = [];
            rows.forEach(function(r, idx){ if((r._failedKeys||[]).length) failedRows.push({row:r, no:r['专利号'], idx:idx}); });
            if(!failedRows.length){ setProgress('完成，共 '+rows.length+' 条，全部成功', false); return; }
            if(round >= 2){ setProgress('完成，共 '+rows.length+' 条，'+failedRows.length+' 条失败（已重试2次）', false); renderPreview(); return; }
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
    function exportXlsx(){
        if(!rows.length){alert('没有数据');return;}
        var headers=ALL_HEADERS;
        var aoa=[headers].concat(rows.map(function(r){return headers.map(function(h){return r[h]||'';});}));
        var csv='﻿'+aoa.map(function(c){return c.map(function(x){return '"'+String(x).replace(/"/g,'""')+'"';}).join(',');}).join('\r\n');
        var blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
        var link=document.createElement('a'); link.href=URL.createObjectURL(blob); link.download='CNIPA专利查询.csv';
        document.body.appendChild(link); link.click(); link.remove();
    }

    var s=document.createElement('style');
    s.textContent='#oa-cnipa-panel{position:fixed;right:16px;top:76px;z-index:999999;width:760px;max-height:calc(100vh - 100px);background:#fff;border:1px solid #b9c6dd;box-shadow:0 8px 28px rgba(0,0,0,.2);font:14px/1.5 Arial,"Microsoft YaHei",sans-serif;overflow:auto;border-radius:8px;}'+
        '#oa-cnipa-head{background:#3664d1;color:#fff;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;font-size:16px;cursor:move;}'+
        '#oa-cnipa-body{padding:12px;}'+
        '#oa-cnipa-input{width:100%;height:80px;border:1px solid #ccc;padding:6px;font:13px/1.4 Consolas,monospace;box-sizing:border-box;}'+
        '#oa-cnipa-panel button{border:1px solid #3664d1;background:#fff;color:#244fc0;border-radius:4px;padding:6px 12px;margin:6px 6px 0 0;cursor:pointer;}'+
        '#oa-cnipa-panel button.primary{background:#3664d1;color:#fff;}'+
        '#oa-cnipa-status{margin:8px 0;font-size:13px;color:#555;}'+
        '#oa-cnipa-status .ok{color:#047857;}'+
        '#oa-cnipa-status .bad{color:#b91c1c;}'+
        '#oa-cnipa-preview-wrap{overflow:auto;border:1px solid #e2e8f0;margin-top:8px;max-height:400px;}'+
        '#oa-cnipa-preview{width:100%;border-collapse:collapse;font-size:12px;}'+
        '#oa-cnipa-preview th,#oa-cnipa-preview td{border:1px solid #e2e8f0;padding:4px;white-space:nowrap;max-width:150px;overflow:hidden;text-overflow:ellipsis;}'+
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
        '<textarea id="oa-cnipa-input" placeholder="每行一个申请号/专利号"></textarea>'+
        '<div><button id="oa-cnipa-start" class="primary">开始查询</button><button id="oa-cnipa-export">导出CSV</button><button id="oa-cnipa-clear">清空</button><button id="oa-cnipa-refresh">刷新状态</button></div>'+
        '<div id="oa-cnipa-fields" style="margin:8px 0;padding:8px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;">'+
            '<div id="oa-cnipa-fields-head" style="cursor:pointer;user-select:none;font-weight:700;color:#334155;"><span id="oa-cnipa-fields-toggle">-</span> 显示字段 <span style="color:#64748b;font-weight:400;font-size:12px;">（勾选要显示的列）</span></div>'+
            '<div id="oa-cnipa-field-list" style="margin-top:6px;"></div>'+
        '</div>'+
        '<div id="oa-cnipa-progress"><span id="oa-cnipa-spinner"></span><span id="oa-cnipa-progress-text">等待输入</span></div>'+
        '<div id="oa-cnipa-preview-wrap"><table id="oa-cnipa-preview"></table></div></div>';
    document.body.appendChild(panel);

    // 添加右下角缩放手柄
    var resizeHandle=document.createElement('div');
    resizeHandle.id='oa-cnipa-resize';
    panel.appendChild(resizeHandle);

    // 最大化/还原
    var isMax=false, savedRect=null;
    document.getElementById('oa-cnipa-max').onclick=function(){
        if(!isMax){
            savedRect={left:panel.style.left, top:panel.style.top, width:panel.style.width, height:panel.style.height};
            panel.style.left='0'; panel.style.top='0';
            panel.style.width='100vw'; panel.style.height='100vh';
            panel.style.maxHeight='none'; panel.style.maxWidth='none';
            isMax=true;
        } else {
            panel.style.left=savedRect.left||''; panel.style.top=savedRect.top||'';
            panel.style.width=savedRect.width||''; panel.style.height=savedRect.height||'';
            panel.style.maxHeight=''; panel.style.maxWidth='';
            isMax=false;
        }
    };

    // 拖动缩放手柄
    (function(){
        var sx=0, sy=0, sw=0, sh=0;
        resizeHandle.addEventListener('mousedown', function(e){
            e.stopPropagation(); e.preventDefault();
            isMax=false;
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
    document.getElementById('oa-cnipa-export').onclick=exportXlsx;
    document.getElementById('oa-cnipa-clear').onclick=function(){rows=[];renderPreview();};
    document.getElementById('oa-cnipa-refresh').onclick=scanAuth;
    setInterval(scanAuth,2000); scanAuth();

    // 拖动面板
    (function makeDraggable(handle){
        var sx=0, sy=0, sl=0, st=0;
        handle.addEventListener('mousedown', function(e){
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
