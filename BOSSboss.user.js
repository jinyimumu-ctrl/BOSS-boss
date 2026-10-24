// ==UserScript==
// @name         BOSS'boss
// @namespace https://github.com/jinyimumu-ctrl
// @version      0.6.0-M6
// @description  BOSS'boss 正式版：引导、重新生成、异常拦截与防御
// @match        https://www.zhipin.com/web/geek/*
// @match        https://www.zhipin.com/job_detail/*
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      api.deepseek.com
// @run-at       document-idle
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

    // ============================================================
    // M2：职位详情页抓取
    // ============================================================
    function scrapeJobDetail() {
        const hasJobTitle = pickText(['.job-banner .name h1', '.job-name h1', 'h1']);
        if (!hasJobTitle) return null;
        const data = {};
        data.jobTitle = clean(hasJobTitle);
        data.salary = decodePUA(clean(pickText(['.job-banner .name .salary', '.salary'])));
        data.location = clean(pickText(['.job-banner p a.text-city', '.job-banner p .text-city'])) || '未知';
        data.experience = clean(pickText(['.job-banner p .text-experiece', '.job-banner p span.text-experiece'])) || '不限';
        data.education = clean(pickText(['.job-banner p .text-degree', '.job-banner p span.text-degree'])) || '不限';
        const jdEl = document.querySelector('.job-detail .job-sec-text, .job-detail .text, .job-sec-text, [class*="job-detail"] .text');
        data.jdText = jdEl ? clean(jdEl.innerText || jdEl.textContent) : '';

        data.companyName = '(未抓到)';
        data.companyScale = '(未抓到)';
        data.companyStage = '未融资';
        data.companyIndustry = '(未抓到)';
        const companyNameEl = document.querySelector('.sider-company .company-info a[title]');
        if (companyNameEl) data.companyName = companyNameEl.getAttribute('title');
        const companyPs = document.querySelectorAll('.sider-company p');
        companyPs.forEach(p => {
            if (p.querySelector('.icon-scale')) data.companyScale = clean(p.textContent);
            if (p.querySelector('.icon-industry')) data.companyIndustry = clean(p.textContent);
            if (p.querySelector('.icon-stage') || /融资|上市|轮/.test(p.textContent)) data.companyStage = clean(p.textContent);
        });

        data.hrName = '';
        data.hrTitle = '';
        const hrNameEl = document.querySelector('.job-boss-info h2.name');
        if (hrNameEl) {
            const clone = hrNameEl.cloneNode(true);
            const statusEl = clone.querySelector('.boss-active-time');
            if (statusEl) statusEl.remove();
            data.hrName = clean(clone.textContent);
        }
        const hrAttrEl = document.querySelector('.job-boss-info .boss-info-attr');
        if (hrAttrEl) {
            let attrText = clean(hrAttrEl.textContent);
            if (data.companyName && attrText.includes(data.companyName)) attrText = attrText.replace(data.companyName, '');
            data.hrTitle = attrText.replace(/^·\s*/, '').replace(/\s*·$/, '').trim();
        }
        data.url = location.href;
        return data;
    }

    // ============================================================
    // M3 核心：DeepSeek API 接入 + M6 重新生成 & 异常重试
    // ============================================================
    const SYSTEM_PROMPT = `你是一名资深求职咨询顾问，服务对象是一位正在BOSS直聘上投递简历的求职者。
你的任务：基于「岗位信息」「公司信息」和「求职者档案」，输出两部分内容——一份顾问分析，一段可直接发送的打招呼话术。

## 核心原则
1. **绝对禁止编造**：所有事实性内容（学校、专业、年级、经历、项目、技能、数据、到岗时间）只能来自求职者档案。你可以提炼、重组、润色语言，但不得添加档案中不存在的任何事实。档案里没有的，宁可不写。
2. **公司信息诚实原则**：对该公司业务的描述，有检索依据就说依据，没有依据就写"公开信息有限"，且必须区分"事实"与"推测"，禁止把推测包装成事实。
3. **咨询顾问视角**：分析要诚实、具体、有判断，不空泛客套。匹配就指出匹配点，不匹配就指出差距并给沟通建议。
4. **读者是HR**：HR每天看几十上百条招呼。话术的生死线是"看起来像单独为我写的，而不是群发的"。

## 输出第一部分：顾问分析（300字以内）
依次回答：
1. **岗位核心诉求**：这个岗位最看重什么（从JD提炼）
2. **公司业务画像**：该公司是做什么的、核心产品/业务是什么、处于什么阶段（基于JD信息；信息不足时明说"公开信息有限"，推测内容须标注）
3. **匹配点**：求职者档案中最对口的经历/技能（具体到项目）
4. **差距与风险**（如有）
5. **沟通策略建议**（一句话）

## 输出第二部分：打招呼话术
硬性要求：
1. **总字数严格控制在120-140字**（BOSS上限140字，必须留余量）
2. **前18个字是生死线**：必须是**最强硬的经历数据**（数字优先，如"5年新媒体运营经验""独立做过0-1项目""心理学专业在读"），**禁止以"您好""你好"等空洞问候开头**；称呼放在数据之后自然衔接。
3. 结构：硬数据钩子（前18字）→ 称呼+一句话身份 → 1-2个与JD直接对应的匹配点（用JD原文关键词）→ 一句收尾（求职意向+礼貌）
4. 称呼规则：优先用HR昵称（如"梁老师"）；HR职位含"总监/合伙人/负责人"时用"姓氏+职位"；无HR姓名时自然省略称呼。
5. 语气：真诚、自信、平等。不谄媚、不吹嘘。禁用"跪求""万分感谢""希望给我一次机会"等低姿态措辞；禁用"精通""专家""顶级"等档案无法支撑的夸大词。
6. **公司/产品见解只进顾问分析，不进招呼词**。
7. 禁止出现：档案中没有的证书/实习/项目/数字；无法兑现的承诺。

## 输出格式
严格按以下格式输出，不要输出任何其他内容：
【顾问分析】
（分析内容）

【招呼词】
（话术内容）`;

    function generateGreeting(jobData, userProfile, isRegenerate) {
        const apiKey = GM_getValue(STORAGE_KEY_API_KEY, '');
        if (!apiKey) {
            alert('请先在“我的档案”Tab 填写并保存你的 DeepSeek API Key！');
            switchTab('profile');
            return;
        }
        if (!userProfile || userProfile.trim() === '') {
            alert('请先在“我的档案”Tab 填写你的个人档案！');
            switchTab('profile');
            return;
        }
        if (!jobData.jdText || jobData.jdText.length < 10) {
            const confirmGen = confirm('⚠️ 未抓取到详细的 JD 原文，这可能会影响 AI 分析的准确度。\n\n确定要强行生成吗？');
            if (!confirmGen) return;
        }

        // 重复投递提醒
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
        if (btn) {
            btn.disabled = true;
            btn.textContent = '正在分析并生成...';
        }
        resultArea.innerHTML = '<div class="bb-placeholder" style="text-align:center; padding: 20px;">AI 正在全力输出中，预计需要 5-10 秒...</div>';

        let userMessage = `【岗位信息】
职位：${jobData.jobTitle}
公司：${jobData.companyName}（${jobData.companyStage}·${jobData.companyScale}·${jobData.companyIndustry}）
薪资：${jobData.salary}｜地点：${jobData.location}｜要求：${jobData.experience}｜学历：${jobData.education}
招聘者：${jobData.hrName}（${jobData.hrTitle}）

【JD原文】
${jobData.jdText}

【我的档案】
${userProfile}`;

        // M6 重新生成指令
        if (isRegenerate) {
            userMessage += `\n\n【补充指令】\n请保持事实不变，换一种表达方式重新生成【顾问分析】和【招呼词】。`;
        }

        GM_xmlhttpRequest({
            method: "POST",
            url: "https://api.deepseek.com/chat/completions",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + apiKey
            },
            data: JSON.stringify({
                model: "deepseek-chat",
                messages: [
                    { role: "system", content: SYSTEM_PROMPT },
                    { role: "user", content: userMessage }
                ],
                temperature: 0.6, // 重新生成时稍微调高一点温度
                stream: false
            }),
            timeout: 30000,
            onload: function (response) {
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = '一键生成招呼词';
                }
                if (response.status === 200) {
                    try {
                        const resData = JSON.parse(response.responseText);
                        const content = resData.choices[0].message.content;
                        const parsed = parseResult(content);
                        if (parsed) {
                            GM_setValue(STORAGE_KEY_LAST_RESULT, {
                                jobTitle: jobData.jobTitle,
                                companyName: jobData.companyName,
                                analysis: parsed.analysis,
                                greeting: parsed.greeting
                            });

                            // 只有第一次生成才记录 Log，重新生成不重复记
                            if (!isRegenerate) {
                                addToLogs(jobData, parsed.greeting);
                            }

                            renderResultHTML(parsed.analysis, parsed.greeting, resultArea, jobData, userProfile);
                        } else {
                            resultArea.innerHTML = `
                                <div class="bb-snapshot-empty">解析 AI 返回内容失败。</div>
                                <button class="bb-btn bb-btn-outline" style="width: 100%; margin-top:8px;" onclick="document.getElementById('bb-generate-btn').click()">重新尝试</button>
                            `;
                        }
                    } catch (e) {
                        resultArea.innerHTML = `
                            <div class="bb-snapshot-empty">解析 AI 返回内容失败。</div>
                            <button class="bb-btn bb-btn-outline" style="width: 100%; margin-top:8px;" onclick="document.getElementById('bb-generate-btn').click()">重新尝试</button>
                        `;
                    }
                } else if (response.status === 401) {
                    resultArea.innerHTML = '<div class="bb-snapshot-empty">API Key 无效，请去官网确认或重新填写。</div>';
                    switchTab('profile');
                } else if (response.status === 402) {
                    resultArea.innerHTML = '<div class="bb-snapshot-empty">余额不足。请前往 DeepSeek 官网充值后重试。</div>';
                } else {
                    resultArea.innerHTML = `
                        <div class="bb-snapshot-empty">请求失败 (错误码: ${response.status})。</div>
                        <button class="bb-btn bb-btn-outline" style="width: 100%; margin-top:8px;" onclick="document.getElementById('bb-generate-btn').click()">重试</button>
                    `;
                }
            },
            onerror: function () {
                if (btn) { btn.disabled = false; btn.textContent = '一键生成招呼词'; }
                resultArea.innerHTML = `
                    <div class="bb-snapshot-empty">网络请求失败，请检查网络或代理。</div>
                    <button class="bb-btn bb-btn-outline" style="width: 100%; margin-top:8px;" onclick="document.getElementById('bb-generate-btn').click()">重试</button>
                `;
            },
            ontimeout: function () {
                if (btn) { btn.disabled = false; btn.textContent = '一键生成招呼词'; }
                resultArea.innerHTML = `
                    <div class="bb-snapshot-empty">请求超时，服务器可能正忙。</div>
                    <button class="bb-btn bb-btn-outline" style="width: 100%; margin-top:8px;" onclick="document.getElementById('bb-generate-btn').click()">重试</button>
                `;
            }
        });
    }

    function parseResult(content) {
        const analysisMatch = content.match(/【顾问分析】([\s\S]*?)(?=【招呼词】|$)/);
        const greetingMatch = content.match(/【招呼词】([\s\S]*?)$/);
        if (!analysisMatch && !greetingMatch) return null;
        return {
            analysis: analysisMatch ? analysisMatch[1].trim() : '未能解析出分析内容。',
            greeting: greetingMatch ? greetingMatch[1].trim() : '未能解析出招呼词内容。'
        };
    }

    function addToLogs(jobData, greeting) {
        const logs = GM_getValue(STORAGE_KEY_LOGS, []);
        const newLog = {
            time: new Date().toLocaleString('zh-CN', { hour12: false }),
            company: jobData.companyName,
            job: jobData.jobTitle,
            greeting: greeting
        };
        logs.unshift(newLog);
        if (logs.length > 100) logs.pop();
        GM_setValue(STORAGE_KEY_LOGS, logs);
        renderLogsTab();
    }

    // ============================================================
    // M4/M5/M6 核心：渲染、重新生成、填入
    // ============================================================
    function renderResultHTML(analysis, greeting, container, jobData, userProfile) {
        const html = `
            <div style="margin-bottom: 12px;">
                <div class="bb-badge-warn" style="margin-bottom: 4px; display:inline-block;">顾问分析</div>
                <div class="bb-snapshot-jd" style="max-height: 160px;">${escapeHtml(analysis)}</div>
            </div>
            <div>
                <div style="display:flex; justify-content:space-between; align-items:flex-end; margin-bottom: 4px;">
                    <div class="bb-badge-ok">招呼词 (可编辑)</div>
                    <div id="bb-char-count" style="font-size: 11px; color: #6b7280;">0/140字</div>
                </div>
                <textarea class="bb-profile-input" id="bb-greeting-text" style="min-height: 100px; border-color: #0ea5e9; padding-bottom: 20px;">${escapeHtml(greeting)}</textarea>

                <div style="display:flex; gap: 8px; margin-top: 8px;">
                    <button class="bb-btn bb-btn-outline" id="bb-regen-btn" style="flex:1;">🔄 重新生成</button>
                    <button class="bb-btn bb-btn-primary" id="bb-fill-btn" style="flex:2;">一键填入BOSS</button>
                </div>
                <div style="margin-top: 6px; font-size: 11.5px; color: #ea580c; text-align: center;">
                    ⚠️ 填入后请手动按 Enter 发送（脚本绝不自动发送）
                </div>
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
            if (len > 140) {
                countDiv.style.color = '#dc2626';
                countDiv.style.fontWeight = 'bold';
            } else {
                countDiv.style.color = '#6b7280';
                countDiv.style.fontWeight = 'normal';
            }
        }

        textArea.addEventListener('input', updateCount);
        updateCount();

        // M6: 重新生成绑定
        regenBtn.addEventListener('click', function () {
            if (jobData && userProfile) {
                generateGreeting(jobData, userProfile, true);
            }
        });

        fillBtn.addEventListener('click', function () {
            const finalGreeting = textArea.value;
            if (!finalGreeting) {
                alert('招呼词为空，无法填入。');
                return;
            }

            const chatInput = findChatInput();
            if (!chatInput) {
                alert('未找到聊天输入框。请确认你当前处于聊天界面，并且聊天窗口已打开。');
                return;
            }

            setNativeValueAndDispatch(chatInput, finalGreeting);
            chatInput.focus();

            fillBtn.textContent = '✅ 已填入，请按 Enter！';
            fillBtn.style.background = '#16a34a';
            setTimeout(() => {
                fillBtn.textContent = '一键填入BOSS';
                fillBtn.style.background = '#0ea5e9';
            }, 3000);
        });
    }

    // ============================================================
    // M5：投递记录渲染
    // ============================================================
    function renderLogsTab() {
        if (!shadowRoot) return;
        const container = shadowRoot.getElementById('bb-logs-list');
        if (!container) return;

        const logs = GM_getValue(STORAGE_KEY_LOGS, []);
        if (logs.length === 0) {
            container.innerHTML = '<div class="bb-placeholder">暂无投递记录。每次生成招呼词后会自动记录。</div>';
            return;
        }

        let html = '<div style="margin-bottom: 10px; display:flex; justify-content:space-between; align-items:center;">';
        html += `<span style="font-size:12px; color:#6b7280;">共 ${logs.length} 条记录</span>`;
        html += `<button class="bb-btn bb-btn-outline" id="bb-copy-logs" style="padding: 4px 8px; font-size: 12px;">复制全部(MD)</button>`;
        html += '</div>';

        logs.forEach(log => {
            html += `
                <div style="border: 1px solid #e5e7eb; border-radius: 6px; padding: 8px; margin-bottom: 8px; background: #f9fafb;">
                    <div style="font-size: 11px; color: #6b7280; margin-bottom: 4px;">${log.time}</div>
                    <div style="font-weight: 600; font-size: 13px; margin-bottom: 2px;">${escapeHtml(log.company)}</div>
                    <div style="font-size: 12px; color: #374151; margin-bottom: 6px;">${escapeHtml(log.job)}</div>
                    <div style="font-size: 11px; color: #6b7280; background: #fff; padding: 6px; border-radius: 4px; border: 1px solid #f3f4f6;">${escapeHtml(log.greeting)}</div>
                </div>
            `;
        });
        container.innerHTML = html;

        container.querySelector('#bb-copy-logs').addEventListener('click', function() {
            let md = `# 投递记录导出 (${new Date().toLocaleDateString()})\n\n`;
            md += `| 时间 | 公司 | 岗位 | 招呼词 |\n|---|---|---|---|\n`;
            logs.forEach(log => {
                const cleanGreeting = log.greeting.replace(/\n/g, ' ');
                md += `| ${log.time} | ${log.company} | ${log.job} | ${cleanGreeting} |\n`;
            });

            navigator.clipboard.writeText(md).then(() => {
                alert('✅ 已复制到剪贴板！');
            }).catch(err => {
                alert('❌ 复制失败，可能是浏览器限制了剪贴板权限。');
            });
        });
    }

    // ============================================================
    // 页面模式判断 + 智能抓取重试 + 状态恢复
    // ============================================================
    let currentPageMode = 'unknown';
    let lastRouteKey = '';
    let scrapeRetryCount = 0;
    let scrapeTimer = null;

    function detectPageMode() {
        const isJobDetailUrl = /\/job_detail\//.test(location.pathname);
        const hasBanner = document.querySelector('.job-banner');
        if (isJobDetailUrl || hasBanner) return 'job_detail';
        if (/\/web\/geek\/chat/.test(location.pathname)) return 'chat';
        return 'other';
    }

    function onRouteMaybeChanged() {
        const routeKey = location.pathname + location.search;
        if (routeKey === lastRouteKey) return;
        lastRouteKey = routeKey;
        const mode = detectPageMode();

        updatePanelForMode(mode);

        if (mode === 'job_detail') {
            scrapeRetryCount = 0;
            tryScrapeJob(1500);
        }
    }

    function tryScrapeJob(delay) {
        if (scrapeTimer) clearTimeout(scrapeTimer);
        scrapeTimer = setTimeout(function () {
            const data = scrapeJobDetail();
            if (data) {
                GM_setValue(STORAGE_KEY_LAST_JOB, data);
                renderJobSnapshot(data);
                scrapeRetryCount = 0;
            } else if (scrapeRetryCount < 5) {
                scrapeRetryCount++;
                tryScrapeJob(1000);
            } else {
                renderJobSnapshot(null);
            }
        }, delay);
    }

    (function hookHistory() {
        ['pushState', 'replaceState'].forEach(function (name) {
            const orig = history[name];
            history[name] = function () {
                const ret = orig.apply(this, arguments);
                onRouteMaybeChanged();
                return ret;
            };
        });
        window.addEventListener('popstate', onRouteMaybeChanged);
        let lastHref = location.href;
        setInterval(function () {
            if (location.href !== lastHref) {
                lastHref = location.href;
                onRouteMaybeChanged();
            }
        }, 800);
    })();

    // ============================================================
    // 面板UI
    // ============================================================
    let panelHost = null;
    let shadowRoot = null;

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
                <span class="bb-title">BOSS'boss <small style="font-weight:400;opacity:0.85">M6</small></span>
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
                        <button class="bb-btn bb-btn-primary" id="bb-generate-btn" style="width: 100%;" disabled>一键生成招呼词</button>
                    </div>
                    <div id="bb-generate-result" style="margin-top: 12px;"></div>
                </div>
                <div class="bb-tab-content" data-content="profile">
                    <div class="bb-form-group">
                        <label>DeepSeek API Key (必填)</label>
                        <input type="password" id="bb-apikey-input" class="bb-profile-input" style="min-height: 32px; padding: 6px;" placeholder="sk-...">
                        <div style="margin-top: 4px;">
                            <a href="https://platform.deepseek.com/" target="_blank" class="bb-link">👉 点此去 DeepSeek 获取 API Key (仅需几元)</a>
                        </div>
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
        shadowRoot.querySelectorAll('.bb-tab').forEach(function (btn) {
            btn.classList.toggle('active', btn.dataset.tab === name);
        });
        shadowRoot.querySelectorAll('.bb-tab-content').forEach(function (c) {
            c.classList.toggle('active', c.dataset.content === name);
        });
        GM_setValue(STORAGE_KEY_ACTIVE_TAB, name);

        if (name === 'logs') {
            renderLogsTab();
        }
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
            if (lastResult) {
                const jobData = GM_getValue(STORAGE_KEY_LAST_JOB, null);
                if (jobData && lastResult.jobTitle === jobData.jobTitle && lastResult.companyName === jobData.companyName) {
                    renderResultHTML(lastResult.analysis, lastResult.greeting, resultArea, jobData, userProfile);
                } else {
                    resultArea.innerHTML = '';
                }
            }
        } else if (mode === 'chat') {
            genBtn.disabled = true;
            genBtn.style.display = 'none';
            snapshot.innerHTML = '<div class="bb-placeholder" style="color:#16a34a; font-weight:bold;">当前在聊天界面，已为你恢复最新生成的招呼词。</div>';

            if (lastResult) {
                const jobData = GM_getValue(STORAGE_KEY_LAST_JOB, null);
                renderResultHTML(lastResult.analysis, lastResult.greeting, resultArea, jobData, userProfile);
            } else {
                resultArea.innerHTML = '<div class="bb-placeholder">暂无记录，请先前往职位详情页生成。</div>';
            }
        } else {
            snapshot.innerHTML = '<div class="bb-placeholder">当前不在职位详情页。请打开职位页。</div>';
            genBtn.disabled = true;
            genBtn.style.display = 'block';
            resultArea.innerHTML = '';
        }
    }

    function renderJobSnapshot(data) {
        if (!shadowRoot) return;
        const container = shadowRoot.getElementById('bb-job-snapshot');
        if (!container) return;
        if (!data) {
            container.innerHTML = '<div class="bb-placeholder">未能抓取到岗位信息。请刷新页面重试。</div>';
            return;
        }

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

        shadowRoot.querySelectorAll('.bb-tab').forEach(function (btn) {
            btn.addEventListener('click', function () { switchTab(btn.dataset.tab); });
        });
        shadowRoot.getElementById('bb-collapse').addEventListener('click', function () { setCollapsed(true); });
        shadowRoot.getElementById('bb-collapsed-bar').addEventListener('click', function () { setCollapsed(false); });

        const apiKeyInput = shadowRoot.getElementById('bb-apikey-input');
        const profileInput = shadowRoot.getElementById('bb-profile-input');
        apiKeyInput.value = GM_getValue(STORAGE_KEY_API_KEY, '');
        profileInput.value = GM_getValue(STORAGE_KEY_PROFILE, '');

        shadowRoot.getElementById('bb-save-profile').addEventListener('click', function () {
            GM_setValue(STORAGE_KEY_API_KEY, apiKeyInput.value.trim());
            GM_setValue(STORAGE_KEY_PROFILE, profileInput.value);
            const status = shadowRoot.getElementById('bb-profile-status');
            status.textContent = '已保存';
            setTimeout(function () { status.textContent = ''; }, 3000);
        });

        shadowRoot.getElementById('bb-copy-profile').addEventListener('click', function () {
            navigator.clipboard.writeText(profileInput.value).then(() => {
                alert('✅ 档案已复制到剪贴板！');
            }).catch(err => {
                alert('❌ 复制失败，请手动全选复制。');
            });
        });

        shadowRoot.getElementById('bb-import-profile').addEventListener('click', async function () {
            try {
                const text = await navigator.clipboard.readText();
                if (text) {
                    profileInput.value = text;
                    alert('✅ 已从剪贴板导入内容，请确认无误后点击“保存设置”。');
                } else {
                    alert('剪贴板为空。');
                }
            } catch (err) {
                alert('❌ 浏览器拒绝读取剪贴板。请手动在文本框内粘贴。');
            }
        });

        shadowRoot.getElementById('bb-generate-btn').addEventListener('click', function () {
            const jobData = GM_getValue(STORAGE_KEY_LAST_JOB, null);
            const userProfile = GM_getValue(STORAGE_KEY_PROFILE, '');
            if (!jobData) {
                alert('未获取到当前岗位信息，请刷新或重新抓取。');
                return;
            }
            generateGreeting(jobData, userProfile, false);
        });

        const collapsed = GM_getValue(STORAGE_KEY_COLLAPSED, false);
        setCollapsed(collapsed, false);
        switchTab(GM_getValue(STORAGE_KEY_ACTIVE_TAB, 'generate'));

        currentPageMode = detectPageMode();
        lastRouteKey = location.pathname + location.search;
        updatePanelForMode(currentPageMode);

        if (currentPageMode === 'job_detail') {
            scrapeRetryCount = 0;
            tryScrapeJob(1500);
        }
    }

    function boot() {
        if (document.body) { initPanel(); }
        else {
            const timer = setInterval(function () {
                if (document.body) { clearInterval(timer); initPanel(); }
            }, 100);
        }
    }

    boot();
})();
