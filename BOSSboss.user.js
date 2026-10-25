// ==UserScript==
// @name         BOSS'boss
// @namespace    https://github.com/jinyimumu-ctrl
// @version      0.7.1-M6
// @description  BOSS'boss 正式版：移除强制截断，尊重自然表达，极限字数提示
// @match        https://www.zhipin.com/web/geek/*
// @match        https://www.zhipin.com/job_detail/*
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      api.deepseek.com
// @run-at       document-idle
// @author       jinyimumu
// @updateURL    https://github.com/jinyimumu-ctrl/BOSS-boss/raw/refs/heads/main/BOSSboss.user.js
// @downloadURL  https://github.com/jinyimumu-ctrl/BOSS-boss/raw/refs/heads/main/BOSSboss.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ============================================================
    // M0 核心：原生 setter 写入聊天框
    // ============================================================
    const INPUT_SELECTORS = [
        '#boss-chat-editor-input', '.boss-chat-editor-input', '.chat-input',
        'textarea[placeholder*="回复"]', 'textarea[placeholder*="输入"]', '[contenteditable="true"]'
    ];
    function findChatInput() {
        for (const sel of INPUT_SELECTORS) {
            const el = document.querySelector(sel);
            if (el) return el;
        }
        return null;
    }
    function setNativeValueAndDispatch(el, value) {
        const tag = el.tagName.toLowerCase();
        if (tag === 'input') {
            Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, value);
        } else if (tag === 'textarea') {
            Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(el, value);
        } else if (el.isContentEditable) {
            el.focus(); el.textContent = value;
        } else { return; }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // ============================================================
    // 工具函数 & 存储Key
    // ============================================================
    const STORAGE_KEY_COLLAPSED   = 'bossboss_panel_collapsed';
    const STORAGE_KEY_ACTIVE_TAB  = 'bossboss_active_tab';
    const STORAGE_KEY_PROFILE     = 'bossboss_profile';
    const STORAGE_KEY_LAST_JOB    = 'bossboss_last_job_snapshot';
    const STORAGE_KEY_API_KEY     = 'bossboss_api_key';
    const STORAGE_KEY_LAST_RESULT = 'bossboss_last_result';
    const STORAGE_KEY_LOGS        = 'bossboss_logs';

    function pickText(selectors, root) {
        root = root || document;
        for (const sel of selectors) {
            const el = root.querySelector(sel);
            if (el && el.textContent.trim()) return el.textContent.trim().replace(/\s+/g, ' ');
        }
        return '';
    }
    function clean(text) {
        if (!text) return '';
        return text.replace(/\s+/g, ' ').trim();
    }
    function decodePUA(text) {
        if (!text) return '';
        let out = '';
        for (const ch of text) {
            const code = ch.codePointAt(0);
            if (code >= 0xE031 && code <= 0xE03A) out += String.fromCharCode(code - 0xE031 + 48);
            else out += ch;
        }
        return out;
    }
    function escapeHtml(str) {
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function formatAIOutput(text) {
        if (!text) return '';
        let html = escapeHtml(text);
        html = html.replace(/\*\*(.*?)\*\*/g, '<span style="color:#dc2626; font-weight:bold;">$1</span>');
        html = html.replace(/\n/g, '<br>');
        return html;
    }

    // ============================================================
    // M2：职位详情页抓取
    // ============================================================
    function scrapeJobDetail() {
        const header = document.querySelector('.job-detail-header');
        const container = header ? header.parentElement : document.querySelector('.job-detail-box');

        let titleText = '';
        if (container) titleText = pickText(['.job-name', 'h1'], container);
        if (!titleText) titleText = pickText(['.job-banner .name h1', '.job-name', 'h1']);
        if (!titleText) titleText = document.title.split('-')[0].trim().replace('BOSS直聘', '');

        const data = {};
        data.jobTitle = clean(titleText) || '未知岗位';
        data.salary = decodePUA(clean(pickText(['.job-salary', '.job-banner .salary', '.salary'], container))) || '面议';

        let loc = '', exp = '', edu = '';
        if (container) {
            const tagList = Array.from(container.querySelectorAll('.tag-list li, .info-primary .text')).map(el => clean(el.textContent));
            if (tagList.length > 0) {
                const validTags = tagList.filter(t => t && t.length < 15 && !t.includes('产品') && !t.includes('全职'));
                loc = validTags.find(t => /市|区|北京|上海|广州|深圳|杭州|成都|武汉|南京|西安|苏州|天津|重庆|长沙|郑州|东莞|青岛|合肥|佛山|宁波|厦门|福州|济南|大连|珠海|无锡|昆明|哈尔滨|长春|沈阳|石家庄|南昌|贵阳|太原|南宁|兰州|乌鲁木齐|海口|呼和浩特|银川|西宁|拉萨|香港|澳门|台北/.test(t)) || '';
                exp = validTags.find(t => /天\/周|个月|\d+-\d+年|经验不限|应届/.test(t)) || '';
                edu = validTags.find(t => /本科|大专|硕士|博士|中专|高中|学历不限/.test(t)) || '';
            }
        }
        data.location = loc || '未知';
        data.experience = exp || '不限';
        data.education = edu || '不限';

        let jdText = '';
        const titleNodes = Array.from(document.querySelectorAll('h3, h2, .title')).filter(el =>
            el.innerText.includes('职位描述') || el.innerText.includes('岗位职责')
        );
        if (titleNodes.length > 0) {
            const jdContainer = titleNodes[0].parentElement;
            if (jdContainer) jdText = jdContainer.innerText.replace('职位描述', '').replace('岗位职责', '').trim();
        }
        if (!jdText || jdText.length < 20) {
             const jdEl = document.querySelector('.job-detail-section .text, .job-sec-text, .job-detail-body .desc');
             if (jdEl) jdText = jdEl.innerText || jdEl.textContent;
        }
        data.jdText = jdText ? clean(jdText.replace(/直聘|kanzhun|boss/ig, '')) : '';

        data.hrName = ''; data.hrTitle = ''; data.companyName = '(未抓到)';
        data.companyScale = '(未抓到)'; data.companyStage = '未融资'; data.companyIndustry = '(未抓到)';

        const hrBox = document.querySelector('.job-boss-info');
        if (hrBox) {
            const nameEl = hrBox.querySelector('h2.name, .name');
            if (nameEl) {
                const clone = nameEl.cloneNode(true);
                const statusEl = clone.querySelector('.boss-active-time');
                if (statusEl) statusEl.remove();
                data.hrName = clean(clone.textContent);
            }
            const attrEl = hrBox.querySelector('.boss-info-attr');
            if (attrEl) {
                const attrText = clean(attrEl.textContent);
                const parts = attrText.split('·').map(t => t.trim());
                if (parts.length >= 2) { data.companyName = parts[0]; data.hrTitle = parts[1]; }
                else { data.hrTitle = attrText; }
            }
        }

        const companyBox = document.querySelector('.sider-company');
        if (companyBox) {
             const nameEl = companyBox.querySelector('.company-info a[title]');
             if (nameEl) data.companyName = nameEl.getAttribute('title');
             const companyPs = companyBox.querySelectorAll('p');
             companyPs.forEach(p => {
                if (p.querySelector('.icon-scale')) data.companyScale = clean(p.textContent);
                if (p.querySelector('.icon-industry')) data.companyIndustry = clean(p.textContent);
                if (p.querySelector('.icon-stage') || /融资|上市|轮/.test(p.textContent)) data.companyStage = clean(p.textContent);
             });
        }
        data.url = location.href;
        return data;
    }

    // ============================================================
    // M3 核心：DeepSeek API 接入
    // ============================================================
    const SYSTEM_PROMPT = `你是一名极其犀利、直言不讳的资深求职咨询顾问。你的服务对象正在BOSS直聘上投递简历。
你的任务：基于「岗位信息」和「求职者档案」，先给出直观的匹配度诊断，再给出深度分析，最后生成打招呼话术。

## 核心原则
1. **绝对禁止编造**：事实内容只能来自求职者档案，不得虚构。
2. **犀利诊断**：不要客套，直接指出优缺点。
3. **高亮重点**：在输出中，必须使用 **双星号** 来包裹你提取的核心关键词（如技能、经验要求、核心差距），以便前端高亮显示。

## 输出结构
请严格按照以下四个部分依次输出，不要输出任何多余的废话，不要使用其他Markdown语法（如 # 标题）：

【匹配度评分】
（直接写一个 0-100 的纯数字，例如：75）

【投递建议】
（只能从以下四个词中选一个：强烈建议投递 / 建议投递 / 谨慎考虑 / 不建议投递。并附上一句话的核心理由）

【核心差距】
（用1-2句话直击痛点：求职者目前最欠缺的硬性条件或经验是什么？如果完全匹配则写“无明显硬伤”）

【深度岗位分析】
（300字以内。依次分析：1. 岗位核心诉求；2. 匹配点分析；3. 公司/业务推测；4. 沟通策略。）

【招呼词】
（极度重要，请严格遵守以下规则）：
1. **【字数警戒线】**：总字数必须严格控制在 120-135 字！请在心里默数你的字数，如果超过 135 字，立刻删除多余的形容词或客套话（如“期待回复”），直到满足要求。
2. **【开局禁令】**：第一句话绝对禁止使用“您好”、“韩先生好”、“我是XX大学”开头。
3. **【黄金前18字】**：第一句话必须是你的【最强硬经历数据】或【最直接的业务匹配点】（如：独立操盘校园小程序/拥有3段大厂产品实习经验）。
4. **称呼后置**：把称呼（如“韩先生”）自然地放在数据之后，或者干脆省略。
5. **精简结构**：【硬核数据钩子】 -> 【一句称呼及身份】 -> 【一句话匹配JD核心诉求】 -> 【表达意向】。绝不写废话。`;

    function generateGreeting(jobData, userProfile, isRegenerate) {
        const apiKey = GM_getValue(STORAGE_KEY_API_KEY, '');
        if (!apiKey) { alert('请先在“我的档案”Tab 填写并保存你的 DeepSeek API Key！'); switchTab('profile'); return; }
        if (!userProfile || userProfile.trim() === '') { alert('请先在“我的档案”Tab 填写你的个人档案！'); switchTab('profile'); return; }
        if (!jobData.jdText || jobData.jdText.length < 10) {
            const confirmGen = confirm('⚠️ 未抓取到详细的 JD 原文，这可能会影响 AI 分析的准确度。\n\n确定要强行生成吗？');
            if (!confirmGen) return;
        }

        if (!isRegenerate) {
            const logs = GM_getValue(STORAGE_KEY_LOGS, []);
            const isDuplicate = logs.some(log => log.company === jobData.companyName && log.job === jobData.jobTitle);
            if (isDuplicate) {
                const confirmGen = confirm(`⚠️ 提醒：你之前已经投递过【${jobData.companyName}】的【${jobData.jobTitle}】。\n\n确定要再次生成并投递吗？`);
                if (!confirmGen) return;
            }
        }

        const btn = shadowRoot.getElementById('bb-generate-btn');
        const resultArea = shadowRoot.getElementById('bb-generate-result');
        if (btn) { btn.disabled = true; btn.textContent = '正在深度诊断并生成...'; }
        resultArea.innerHTML = '<div class="bb-placeholder" style="text-align:center; padding: 20px;">AI 顾问正在为你进行岗位诊断，预计需要 5-10 秒...</div>';

        let userMessage = `【岗位信息】\n职位：${jobData.jobTitle}\n公司：${jobData.companyName}（${jobData.companyStage}·${jobData.companyScale}·${jobData.companyIndustry}）\n薪资：${jobData.salary}｜地点：${jobData.location}｜要求：${jobData.experience}｜学历：${jobData.education}\n招聘者：${jobData.hrName}（${jobData.hrTitle}）\n\n【JD原文】\n${jobData.jdText}\n\n【我的档案】\n${userProfile}`;
        if (isRegenerate) { userMessage += `\n\n【补充指令】\n请保持事实不变，换一种表达方式重新生成以上所有内容。尤其是招呼词，换个更强有力的开头！`; }

        GM_xmlhttpRequest({
            method: "POST",
            url: "https://api.deepseek.com/chat/completions",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
            data: JSON.stringify({
                model: "deepseek-chat",
                messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userMessage }],
                temperature: isRegenerate ? 0.7 : 0.4,
                stream: false
            }),
            timeout: 30000,
            onload: function (response) {
                if (btn) { btn.disabled = false; btn.textContent = '一键诊断并生成'; }
                if (response.status === 200) {
                    try {
                        const resData = JSON.parse(response.responseText);
                        const content = resData.choices[0].message.content;
                        const parsed = parseResult(content);
                        if (parsed) {
                            GM_setValue(STORAGE_KEY_LAST_RESULT, {
                                jobTitle: jobData.jobTitle, companyName: jobData.companyName,
                                ...parsed
                            });
                            if (!isRegenerate) addToLogs(jobData, parsed.greeting);
                            renderResultHTML(parsed, resultArea, jobData, userProfile);
                        } else {
                            resultArea.innerHTML = `
                                <div class="bb-snapshot-empty">解析 AI 返回内容失败，可能是格式不对。</div>
                                <div style="margin-top: 8px; font-size: 12px; color: #6b7280; background: #f3f4f6; padding: 8px; border-radius: 4px; max-height: 150px; overflow-y: auto;">
                                    AI 原始返回：<br>${escapeHtml(content)}
                                </div>
                                <button class="bb-btn bb-btn-outline" style="width: 100%; margin-top:8px;" onclick="document.getElementById('bb-generate-btn').click()">重新尝试</button>
                            `;
                        }
                    } catch (e) {
                        resultArea.innerHTML = '<div class="bb-snapshot-empty">解析 AI 返回内容出错。</div><button class="bb-btn bb-btn-outline" style="width: 100%; margin-top:8px;" onclick="document.getElementById(\'bb-generate-btn\').click()">重新尝试</button>';
                    }
                } else if (response.status === 401) {
                    resultArea.innerHTML = '<div class="bb-snapshot-empty">API Key 无效，请去官网确认。</div>'; switchTab('profile');
                } else if (response.status === 402) {
                    resultArea.innerHTML = '<div class="bb-snapshot-empty">余额不足。请前往 DeepSeek 官网充值。</div>';
                } else {
                    resultArea.innerHTML = `<div class="bb-snapshot-empty">请求失败 (${response.status})。</div><button class="bb-btn bb-btn-outline" style="width: 100%; margin-top:8px;" onclick="document.getElementById('bb-generate-btn').click()">重试</button>`;
                }
            },
            onerror: function () { if (btn) { btn.disabled = false; btn.textContent = '一键诊断并生成'; } resultArea.innerHTML = '<div class="bb-snapshot-empty">网络请求失败。</div>'; },
            ontimeout: function () { if (btn) { btn.disabled = false; btn.textContent = '一键诊断并生成'; } resultArea.innerHTML = '<div class="bb-snapshot-empty">请求超时。</div>'; }
        });
    }

    function parseResult(content) {
        let normalized = content.replace(/\*\*/g, '');

        const scoreMatch = normalized.match(/【匹配度评分】\s*([\s\S]*?)(?=【投递建议】|$)/);
        const adviceMatch = normalized.match(/【投递建议】\s*([\s\S]*?)(?=【核心差距】|$)/);
        const gapMatch = normalized.match(/【核心差距】\s*([\s\S]*?)(?=【深度岗位分析】|$)/);
        const analysisMatch = normalized.match(/【深度岗位分析】\s*([\s\S]*?)(?=【招呼词】|$)/);
        const greetingMatch = normalized.match(/【招呼词】\s*([\s\S]*?)$/);

        if (!greetingMatch) return null;

        return {
            score: scoreMatch ? scoreMatch[1].trim().replace(/[^\d]/g, '') : '--',
            advice: adviceMatch ? adviceMatch[1].trim() : '暂无建议',
            gap: gapMatch ? gapMatch[1].trim() : '暂无分析',
            analysis: analysisMatch ? analysisMatch[1].trim() : '暂无分析',
            greeting: greetingMatch[1].trim()
        };
    }

    function addToLogs(jobData, greeting) {
        const logs = GM_getValue(STORAGE_KEY_LOGS, []);
        logs.unshift({ time: new Date().toLocaleString('zh-CN', { hour12: false }), company: jobData.companyName, job: jobData.jobTitle, greeting: greeting });
        if (logs.length > 100) logs.pop();
        GM_setValue(STORAGE_KEY_LOGS, logs);
        renderLogsTab();
    }

    // ============================================================
    // M4/M5/M6 核心：全新卡片式渲染与填入
    // ============================================================
    function renderResultHTML(parsed, container, jobData, userProfile) {
        let scoreColor = '#16a34a';
        const scoreNum = parseInt(parsed.score);
        if (scoreNum < 60) scoreColor = '#dc2626';
        else if (scoreNum < 80) scoreColor = '#ea580c';

        const charLen = parsed.greeting.length;
        const charColor = charLen > 140 ? '#dc2626' : '#6b7280';
        const charWeight = charLen > 140 ? 'bold' : 'normal';

        const html = `
            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px; margin-bottom: 16px;">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;">
                    <div style="font-size: 12px; color: #64748b; font-weight: 600;">求职匹配度</div>
                    <div style="font-size: 24px; font-weight: 900; color: ${scoreColor}; line-height: 1;">
                        ${parsed.score}<span style="font-size: 12px; font-weight: 500;">/100</span>
                    </div>
                </div>
                <div style="background: #fff; padding: 8px; border-radius: 6px; margin-bottom: 8px; font-size: 13px; font-weight: bold; color: #1e293b;">
                    💡 ${escapeHtml(parsed.advice)}
                </div>
                <div style="font-size: 12.5px; color: #475569; line-height: 1.5;">
                    <span style="color: #dc2626; font-weight: bold;">⚠️ 核心差距：</span>${formatAIOutput(parsed.gap)}
                </div>
            </div>

            <div style="margin-bottom: 16px;">
                <div class="bb-badge-warn" style="margin-bottom: 6px; display:inline-block;">岗位深度分析</div>
                <div style="font-size: 13px; color: #374151; line-height: 1.6; background: #fff; border: 1px solid #f3f4f6; padding: 10px; border-radius: 8px;">
                    ${formatAIOutput(parsed.analysis)}
                </div>
            </div>

            <div>
                <div style="display:flex; justify-content:space-between; align-items:flex-end; margin-bottom: 6px;">
                    <div class="bb-badge-ok">专属招呼词 (可修改)</div>
                    <div id="bb-char-count" style="font-size: 11px; color: ${charColor}; font-weight: ${charWeight};">${charLen}/140字</div>
                </div>
                <textarea class="bb-profile-input" id="bb-greeting-text" style="min-height: 120px; border-color: #0ea5e9; padding-bottom: 20px; font-size: 13.5px;">${escapeHtml(parsed.greeting)}</textarea>
                <div style="display:flex; gap: 8px; margin-top: 8px;">
                    <button class="bb-btn bb-btn-outline" id="bb-regen-btn" style="flex:1;">🔄 换个说法</button>
                    <button class="bb-btn bb-btn-primary" id="bb-fill-btn" style="flex:2;">一键填入BOSS</button>
                </div>
                <div style="margin-top: 6px; font-size: 11.5px; color: #ea580c; text-align: center;">⚠️ 填入后请手动按 Enter 发送</div>
            </div>
        `;
        container.innerHTML = html;

        const textArea = container.querySelector('#bb-greeting-text');
        const countDiv = container.querySelector('#bb-char-count');
        const fillBtn = container.querySelector('#bb-fill-btn');
        const regenBtn = container.querySelector('#bb-regen-btn');

        function updateCount() {
            const len = textArea.value.length;
            countDiv.textContent = `${len}/140字`;
            countDiv.style.color = len > 140 ? '#dc2626' : '#6b7280';
            countDiv.style.fontWeight = len > 140 ? 'bold' : 'normal';
        }

        textArea.addEventListener('input', updateCount);
        updateCount();

        regenBtn.addEventListener('click', function () { if (jobData && userProfile) generateGreeting(jobData, userProfile, true); });

        fillBtn.addEventListener('click', function () {
            let finalGreeting = textArea.value;
            if (!finalGreeting) { alert('招呼词为空。'); return; }

            const chatInput = findChatInput();
            if (!chatInput) { alert('未找到聊天输入框，请先进入聊天界面。'); return; }

            // 直接原样填入，不做任何截断
            setNativeValueAndDispatch(chatInput, finalGreeting);
            chatInput.focus();
            fillBtn.textContent = '✅ 已填入，请按 Enter！'; fillBtn.style.background = '#16a34a';
            setTimeout(() => { fillBtn.textContent = '一键填入BOSS'; fillBtn.style.background = '#0ea5e9'; }, 3000);
        });
    }

    function renderLogsTab() {
        if (!shadowRoot) return;
        const container = shadowRoot.getElementById('bb-logs-list');
        if (!container) return;
        const logs = GM_getValue(STORAGE_KEY_LOGS, []);
        if (logs.length === 0) { container.innerHTML = '<div class="bb-placeholder">暂无投递记录。</div>'; return; }

        let html = `<div style="margin-bottom: 10px; display:flex; justify-content:space-between; align-items:center;"><span style="font-size:12px; color:#6b7280;">共 ${logs.length} 条</span><button class="bb-btn bb-btn-outline" id="bb-copy-logs" style="padding: 4px 8px; font-size: 12px;">复制全部(MD)</button></div>`;
        logs.forEach(log => {
            html += `<div style="border: 1px solid #e5e7eb; border-radius: 6px; padding: 8px; margin-bottom: 8px; background: #f9fafb;"><div style="font-size: 11px; color: #6b7280; margin-bottom: 4px;">${log.time}</div><div style="font-weight: 600; font-size: 13px; margin-bottom: 2px;">${escapeHtml(log.company)}</div><div style="font-size: 12px; color: #374151; margin-bottom: 6px;">${escapeHtml(log.job)}</div><div style="font-size: 11px; color: #6b7280; background: #fff; padding: 6px; border-radius: 4px; border: 1px solid #f3f4f6;">${escapeHtml(log.greeting)}</div></div>`;
        });
        container.innerHTML = html;

        container.querySelector('#bb-copy-logs').addEventListener('click', function() {
            let md = `# 投递记录导出 (${new Date().toLocaleDateString()})\n\n| 时间 | 公司 | 岗位 | 招呼词 |\n|---|---|---|---|\n`;
            logs.forEach(log => { md += `| ${log.time} | ${log.company} | ${log.job} | ${log.greeting.replace(/\n/g, ' ')} |\n`; });
            navigator.clipboard.writeText(md).then(() => alert('✅ 已复制到剪贴板！')).catch(err => alert('❌ 复制失败。'));
        });
    }

    // ============================================================
    // 页面状态监听
    // ============================================================
    let currentPageMode = 'unknown';
    let scrapeTimer = null;

    function detectPageMode() {
        if (/\/web\/geek\/chat/.test(location.pathname)) return 'chat';
        const text = document.body.innerText || '';
        if (text.includes('职位描述') || text.includes('岗位职责') || text.includes('任职要求')) return 'job_detail';
        return 'other';
    }

    function observeDOM() {
        const observer = new MutationObserver(() => {
            if (window.observerTimer) clearTimeout(window.observerTimer);
            window.observerTimer = setTimeout(() => {
                const mode = detectPageMode();
                currentPageMode = mode;
                updatePanelForMode(mode);
                if (mode === 'job_detail') {
                    tryScrapeJob(300);
                }
            }, 500);
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }

    function tryScrapeJob(delay) {
        if (scrapeTimer) clearTimeout(scrapeTimer);
        scrapeTimer = setTimeout(function () {
            const data = scrapeJobDetail();
            if (data) {
                const oldData = GM_getValue(STORAGE_KEY_LAST_JOB, null);
                const isDifferentJob = !oldData || oldData.jobTitle !== data.jobTitle || oldData.companyName !== data.companyName;

                GM_setValue(STORAGE_KEY_LAST_JOB, data);
                renderJobSnapshot(data);

                if (isDifferentJob) {
                     shadowRoot.getElementById('bb-generate-result').innerHTML = '';
                     GM_setValue(STORAGE_KEY_LAST_RESULT, null);
                }
            } else {
                renderJobSnapshot(null);
            }
        }, delay);
    }

    // ============================================================
    // 面板UI
    // ============================================================
    let panelHost = null;
    let shadowRoot = null;

    function dumpHTML() {
        const mainArea = document.querySelector('.job-detail-header') || document.querySelector('.job-detail-box') || document.querySelector('.job-banner')?.parentNode || document.querySelector('.main-wrap') || document.body;
        const text = `===== 当前页面结构 =====\nURL: ${location.href}\n模式判定: ${detectPageMode()}\n\n${mainArea.innerHTML.substring(0, 8000)}`;
        navigator.clipboard.writeText(text).then(() => alert('✅ 页面代码已复制！')).catch(err => alert('❌ 复制失败。'));
    }

    function buildPanelHTML() {
        return `
        <style>
            :host { all: initial; }
            * { box-sizing: border-box; }
            .bb-panel { position: fixed; top: 80px; right: 16px; width: 360px; max-height: calc(100vh - 100px); background: #fff; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.18); border: 1px solid #e5e7eb; z-index: 2147483000; display: flex; flex-direction: column; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 13px; color: #111827; line-height: 1.5; }
            .bb-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; background: linear-gradient(135deg, #00bebd 0%, #0ea5e9 100%); color: #fff; }
            .bb-title { font-size: 15px; font-weight: 600; }
            .bb-collapse-btn { background: rgba(255,255,255,0.2); border: none; color: #fff; font-size: 12px; padding: 3px 8px; border-radius: 6px; cursor: pointer; font-family: inherit; }
            .bb-tabs { display: flex; border-bottom: 1px solid #e5e7eb; background: #f9fafb; }
            .bb-tab { flex: 1; padding: 9px 4px; background: none; border: none; border-bottom: 2px solid transparent; font-size: 12.5px; color: #6b7280; cursor: pointer; font-family: inherit; }
            .bb-tab.active { color: #0ea5e9; border-bottom-color: #0ea5e9; font-weight: 600; background: #fff; }
            .bb-body { padding: 12px; overflow-y: auto; flex: 1; min-height: 140px; max-height: calc(100vh - 230px); }
            .bb-tab-content { display: none; }
            .bb-tab-content.active { display: block; }
            .bb-placeholder { color: #6b7280; font-size: 12.5px; }
            .bb-btn { border: none; border-radius: 8px; padding: 8px 14px; font-size: 13px; cursor: pointer; font-family: inherit; }
            .bb-btn-primary { background: #0ea5e9; color: #fff; }
            .bb-btn-primary:hover { background: #0284c7; }
            .bb-btn-primary:disabled { background: #9ca3af; cursor: not-allowed; }
            .bb-btn-outline { background: #f3f4f6; color: #374151; border: 1px solid #d1d5db; }
            .bb-btn-outline:hover { background: #e5e7eb; }
            .bb-profile-input { width: 100%; min-height: 200px; resize: vertical; border: 1px solid #d1d5db; border-radius: 8px; padding: 8px; font-size: 12.5px; font-family: inherit; line-height: 1.5; }
            .bb-profile-actions { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
            .bb-profile-status { font-size: 12px; color: #16a34a; }
            .bb-collapsed-bar { position: fixed; top: 40%; right: 0; width: 36px; height: 110px; background: linear-gradient(135deg, #00bebd 0%, #0ea5e9 100%); color: #fff; border: none; border-radius: 10px 0 0 10px; cursor: pointer; z-index: 2147483000; font-size: 12px; font-weight: 600; writing-mode: vertical-rl; letter-spacing: 2px; display: none; font-family: inherit; }
            .bb-snapshot { font-size: 12px; }
            .bb-snapshot-row { display: flex; padding: 4px 0; border-bottom: 1px dashed #f0f0f0; }
            .bb-snapshot-label { flex: 0 0 72px; color: #6b7280; }
            .bb-snapshot-value { flex: 1; color: #111827; word-break: break-all; }
            .bb-snapshot-empty { color: #dc2626; font-style: italic; }
            .bb-snapshot-jd { max-height: 180px; overflow-y: auto; white-space: pre-wrap; background: #f9fafb; border-radius: 6px; padding: 8px; margin-top: 6px; font-size: 12px; line-height: 1.6; }
            .bb-badge-ok { background: #dcfce7; color: #166534; padding: 1px 6px; border-radius: 4px; font-size: 11px; }
            .bb-badge-warn { background: #fef3c7; color: #92400e; padding: 1px 6px; border-radius: 4px; font-size: 11px; }
            .bb-form-group { margin-bottom: 12px; }
            .bb-form-group label { display: block; font-size: 12px; color: #4b5563; margin-bottom: 4px; }
            .bb-link { color: #0ea5e9; text-decoration: none; font-size: 12px; }
            .bb-link:hover { text-decoration: underline; }
        </style>

        <div class="bb-panel" id="bb-panel">
            <div class="bb-header">
                <span class="bb-title">BOSS'boss <small style="font-weight:400;opacity:0.85">v1.1.1</small></span>
                <button class="bb-collapse-btn" id="bb-collapse">收起</button>
            </div>
            <div class="bb-tabs">
                <button class="bb-tab active" data-tab="generate">生成招呼词</button>
                <button class="bb-tab" data-tab="profile">我的档案</button>
                <button class="bb-tab" data-tab="logs">投递记录</button>
            </div>
            <div class="bb-body">
                <div class="bb-tab-content active" data-content="generate">
                    <div id="bb-job-snapshot">
                        <div class="bb-placeholder">请打开一个 BOSS 职位详情页。</div>
                    </div>
                    <div style="margin-top:10px;">
                        <button class="bb-btn bb-btn-primary" id="bb-generate-btn" style="width: 100%;" disabled>一键诊断并生成</button>
                    </div>
                    <div id="bb-generate-result" style="margin-top: 16px;"></div>

                    <div style="margin-top: 20px; border-top: 1px dashed #e5e7eb; padding-top: 10px; text-align: center;">
                         <button class="bb-btn bb-btn-outline" id="bb-dump-html" style="font-size: 11px; padding: 4px; width: 100%; color: #6b7280;">复制页面代码（调试用）</button>
                    </div>
                </div>
                <div class="bb-tab-content" data-content="profile">
                    <div class="bb-form-group">
                        <label>DeepSeek API Key (必填)</label>
                        <input type="password" id="bb-apikey-input" class="bb-profile-input" style="min-height: 32px; padding: 6px;" placeholder="sk-...">
                        <div style="margin-top: 4px;"><a href="https://platform.deepseek.com/" target="_blank" class="bb-link">👉 点此去 DeepSeek 获取 API Key</a></div>
                    </div>
                    <div class="bb-form-group">
                        <label>个人档案 (乱写没关系，AI会整理)</label>
                        <textarea class="bb-profile-input" id="bb-profile-input" placeholder="建议包含：基本信息 / 经历 / 技能 / 硬性条件 / 性格特点。"></textarea>
                    </div>
                    <div class="bb-profile-actions">
                        <button class="bb-btn bb-btn-primary" id="bb-save-profile">保存设置</button>
                        <button class="bb-btn bb-btn-outline" id="bb-copy-profile">复制导出</button>
                        <button class="bb-btn bb-btn-outline" id="bb-import-profile">粘贴导入</button>
                        <span class="bb-profile-status" id="bb-profile-status"></span>
                    </div>
                </div>
                <div class="bb-tab-content" data-content="logs">
                    <div id="bb-logs-list"></div>
                </div>
            </div>
        </div>
        <button class="bb-collapsed-bar" id="bb-collapsed-bar">BOSS'boss</button>
        `;
    }

    function switchTab(name) {
        shadowRoot.querySelectorAll('.bb-tab').forEach(function (btn) { btn.classList.toggle('active', btn.dataset.tab === name); });
        shadowRoot.querySelectorAll('.bb-tab-content').forEach(function (c) { c.classList.toggle('active', c.dataset.content === name); });
        GM_setValue(STORAGE_KEY_ACTIVE_TAB, name);
        if (name === 'logs') renderLogsTab();
    }

    function setCollapsed(collapsed, persist) {
        if (persist === undefined) persist = true;
        shadowRoot.getElementById('bb-panel').style.display = collapsed ? 'none' : 'flex';
        shadowRoot.getElementById('bb-collapsed-bar').style.display = collapsed ? 'block' : 'none';
        if (persist) GM_setValue(STORAGE_KEY_COLLAPSED, collapsed);
    }

    function updatePanelForMode(mode) {
        if (!shadowRoot) return;
        const snapshot = shadowRoot.getElementById('bb-job-snapshot');
        const genBtn = shadowRoot.getElementById('bb-generate-btn');
        const resultArea = shadowRoot.getElementById('bb-generate-result');
        const lastResult = GM_getValue(STORAGE_KEY_LAST_RESULT, null);
        const userProfile = GM_getValue(STORAGE_KEY_PROFILE, '');

        if (mode === 'job_detail') {
            genBtn.disabled = false;
            genBtn.style.display = 'block';
            if (lastResult && lastResult.score) {
                const jobData = GM_getValue(STORAGE_KEY_LAST_JOB, null);
                if (jobData && lastResult.jobTitle === jobData.jobTitle && lastResult.companyName === jobData.companyName) {
                    renderResultHTML(lastResult, resultArea, jobData, userProfile);
                } else {
                    resultArea.innerHTML = '';
                }
            }
        } else if (mode === 'chat') {
            genBtn.disabled = true; genBtn.style.display = 'none';
            snapshot.innerHTML = '<div class="bb-placeholder" style="color:#16a34a; font-weight:bold;">当前在聊天界面，已为你恢复最新生成的招呼词。</div>';
            if (lastResult && lastResult.score) {
                const jobData = GM_getValue(STORAGE_KEY_LAST_JOB, null);
                renderResultHTML(lastResult, resultArea, jobData, userProfile);
            } else {
                resultArea.innerHTML = '<div class="bb-placeholder">暂无记录，请先前往职位详情页生成。</div>';
            }
        } else {
            snapshot.innerHTML = '<div class="bb-placeholder">当前不在职位详情页。请打开职位页。</div>';
            genBtn.disabled = true; genBtn.style.display = 'block'; resultArea.innerHTML = '';
        }
    }

    function renderJobSnapshot(data) {
        if (!shadowRoot) return;
        const container = shadowRoot.getElementById('bb-job-snapshot');
        if (!container) return;
        if (!data) { container.innerHTML = '<div class="bb-placeholder">未能抓取到岗位信息。请刷新页面重试。</div>'; return; }

        const fields = [
            ['岗位', data.jobTitle], ['薪资', data.salary], ['地点', data.location],
            ['经验', data.experience], ['学历', data.education], ['公司', data.companyName],
            ['规模', data.companyScale], ['行业', data.companyIndustry],
            ['HR', data.hrName + (data.hrTitle ? '（' + data.hrTitle + '）' : '')],
        ];

        let html = '<div class="bb-snapshot">';
        fields.forEach(function (pair) {
            const label = pair[0];
            const value = pair[1] ? clean(pair[1]) : '';
            html += '<div class="bb-snapshot-row"><span class="bb-snapshot-label">' + label + '</span><span class="bb-snapshot-value">' + (value || '<span class="bb-snapshot-empty">（未抓到）</span>') + '</span></div>';
        });
        html += '</div>';
        container.innerHTML = html;
    }

    function initPanel() {
        if (panelHost) return;
        panelHost = document.createElement('div');
        panelHost.id = 'bossboss-panel-host';
        panelHost.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; overflow: visible; z-index: 2147483000;';
        document.body.appendChild(panelHost);
        shadowRoot = panelHost.attachShadow({ mode: 'open' });
        shadowRoot.innerHTML = buildPanelHTML();

        shadowRoot.querySelectorAll('.bb-tab').forEach(function (btn) { btn.addEventListener('click', function () { switchTab(btn.dataset.tab); }); });
        shadowRoot.getElementById('bb-collapse').addEventListener('click', function () { setCollapsed(true); });
        shadowRoot.getElementById('bb-collapsed-bar').addEventListener('click', function () { setCollapsed(false); });
        shadowRoot.getElementById('bb-dump-html').addEventListener('click', dumpHTML);

        const apiKeyInput = shadowRoot.getElementById('bb-apikey-input');
        const profileInput = shadowRoot.getElementById('bb-profile-input');
        apiKeyInput.value = GM_getValue(STORAGE_KEY_API_KEY, '');
        profileInput.value = GM_getValue(STORAGE_KEY_PROFILE, '');

        shadowRoot.getElementById('bb-save-profile').addEventListener('click', function () {
            GM_setValue(STORAGE_KEY_API_KEY, apiKeyInput.value.trim());
            GM_setValue(STORAGE_KEY_PROFILE, profileInput.value);
            const status = shadowRoot.getElementById('bb-profile-status');
            status.textContent = '已保存'; setTimeout(function () { status.textContent = ''; }, 3000);
        });

        shadowRoot.getElementById('bb-copy-profile').addEventListener('click', function () {
            navigator.clipboard.writeText(profileInput.value).then(() => alert('✅ 档案已复制！')).catch(err => alert('❌ 复制失败。'));
        });

        shadowRoot.getElementById('bb-import-profile').addEventListener('click', async function () {
            try {
                const text = await navigator.clipboard.readText();
                if (text) { profileInput.value = text; alert('✅ 已导入，请点击保存。'); }
                else { alert('剪贴板为空。'); }
            } catch (err) { alert('❌ 浏览器拒绝读取剪贴板。'); }
        });

        shadowRoot.getElementById('bb-generate-btn').addEventListener('click', function () {
            const jobData = GM_getValue(STORAGE_KEY_LAST_JOB, null);
            const userProfile = GM_getValue(STORAGE_KEY_PROFILE, '');
            if (!jobData) { alert('未获取到当前岗位信息，请刷新。'); return; }
            generateGreeting(jobData, userProfile, false);
        });

        const collapsed = GM_getValue(STORAGE_KEY_COLLAPSED, false);
        setCollapsed(collapsed, false);
        switchTab(GM_getValue(STORAGE_KEY_ACTIVE_TAB, 'generate'));

        currentPageMode = detectPageMode();
        updatePanelForMode(currentPageMode);

        if (currentPageMode === 'job_detail') {
            tryScrapeJob(1000);
        }

        observeDOM();
    }

    function boot() {
        if (document.body) { initPanel(); }
        else {
            const timer = setInterval(function () {
                if (document.body) { initPanel(); clearInterval(timer); }
            }, 100);
        }
    }

    boot();
})();
