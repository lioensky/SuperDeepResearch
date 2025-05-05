// src/workflow.js
const apiHelper = require('./apiHelper');

// 从环境变量加载模型配置和提示词
const thinkModel = process.env.ThinkModel;
const thinkModelTemp = parseFloat(process.env.ThinkModelTemp);
const thinkModelMaxTokens = parseInt(process.env.ThinkModelMaxTokens);
const fastModel = process.env.FastModel;
const fastModelTemp = parseFloat(process.env.FastModelTemp);
const fastModelMaxTokens = parseInt(process.env.FastModelMaxTokens);

// 新增：加载报告生成模型配置
const paperModel = process.env.PaperModel;
const paperModelTemp = parseFloat(process.env.PaperModelTemp);
const paperModelMaxTokens = parseInt(process.env.PaperModelMaxTokens);

const deepResearchPrompt = process.env.DeepResearchPrompt;
const choicePrompt = process.env.ChoicePrompt;
const realSearchPrompt = process.env.RealSearchPrompt;
const deepJudgePrompt = process.env.DeepJudgePrompt;
const paperGenerationPrompt = process.env.PaperGenerationPrompt;
const timePromptTemplate = process.env.TimePrompt; // 新增：加载时间提示模板
const deepLoopLimit = parseInt(process.env.DeepLoop) || 5; // 读取深度上限，默认5

// --- 工作流状态管理 ---
let currentState = 'INITIAL_CHAT'; // 'INITIAL_CHAT', 'GENERATING_KEYWORDS', 'SEARCHING', 'JUDGING_DEPTH', 'GENERATING_REPORT', 'FINISHED'
let conversationHistory = []; // 完整的对话历史，供强模型使用
let researchPlan = null; // NovaAI 生成的研究计划
let researchLoopCount = 0; // 新增：研究循环计数器
let keywordsToSearch = []; // 待搜索的关键词列表
let searchResults = {}; // 存储搜索结果 { keyword: [result1, result2, ...] }
let accumulatedInfo = []; // 存储所有检索到的信息和中间步骤，用于报告生成
let latestReportContent = null; // 新增：存储最新生成的报告内容

// --- Helper Functions ---
function addMessageToHistory(role, content, modelType = 'think') {
    // 避免添加空的或 null 的 content
    if (content === null || content === undefined) {
        console.warn(`Attempted to add message with null/undefined content for role: ${role}`);
        // 对于 assistant 的 tool_calls 响应，content 可以是 null，但我们通常不直接将其添加到 accumulatedInfo
        if (role === 'assistant' && modelType === 'think') {
             // 如果是强模型的空回复，可能也需要记录？视情况决定
        }
        return; // 不添加空内容的消息到 history 或 accumulatedInfo
    }
    const message = { role, content };
    conversationHistory.push(message);
    // 强模型 (think) 总是能看到完整的 conversationHistory
    // 快模型的消息也记录到 accumulatedInfo，但不一定加入 conversationHistory 的主干给强模型？
    // 决定：所有有效交互都加入 accumulatedInfo，conversationHistory 给强模型看
    accumulatedInfo.push(message);
    console.log(`[History] Added ${role} (${modelType}): ${content.substring(0, 100)}...`);
}

// --- Helper Function: Get Formatted Time Prompt ---
function getFormattedTimePrompt() {
    if (!timePromptTemplate) {
        return ""; // 如果模板未定义，返回空字符串
    }
    const now = new Date();
    // 使用 toLocaleString 获取本地化时间表示（包括时区信息）
    // 例如： '2025/5/6 上午1:05:00' (根据系统区域设置)
    // 你可以根据需要调整 options 来改变格式
    const formattedDateTime = now.toLocaleString('zh-CN', {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        hour12: false, // 使用24小时制
        timeZone: 'Asia/Shanghai' // 明确指定时区
    });
    return timePromptTemplate.replace('{{Date::Time}}', formattedDateTime) + "\n\n"; // 添加换行符分隔
}


// --- 主处理函数 ---
async function handleMessage(userMessage) {
    // 只在用户真正输入时才添加到历史记录
    if (currentState === 'INITIAL_CHAT' || currentState === 'FINISHED') {
         addMessageToHistory('user', userMessage);
    } else {
        // 在研究流程中，用户的输入可能不是直接的对话，而是触发流程的信号
        // 但为了完整性，还是记录下来
        console.log(`[Workflow] User input during active research: "${userMessage}" - may not be used directly by current state.`);
        // accumulatedInfo.push({ role: 'user', content: `(Input during ${currentState}): ${userMessage}` });
    }


    let aiReplyContent = `发生未知错误 (State: ${currentState})`; // Default error

    try {
        switch (currentState) {
            case 'INITIAL_CHAT':
                aiReplyContent = await handleInitialChat();
                break;
            case 'GENERATING_KEYWORDS':
                aiReplyContent = await generateKeywords();
                break;
            case 'SEARCHING':
                 aiReplyContent = await performSearch();
                 break;
            case 'JUDGING_DEPTH':
                 aiReplyContent = await judgeDepth();
                 break;
            case 'GENERATING_REPORT':
                 aiReplyContent = await generateReport();
                 break;
            case 'FINISHED':
                console.log('Workflow State: FINISHED');
                aiReplyContent = '研究已完成。如果您想开始新的研究，请告诉我。';
                // 可以考虑重置状态以开始新的研究
                // resetWorkflow();
                break;
            default:
                console.error('Unknown workflow state:', currentState);
                aiReplyContent = `错误：未知的内部状态 ${currentState}`;
        }

    } catch (error) {
        console.error(`Error in handleMessage (State: ${currentState}):`, error);
        aiReplyContent = `处理消息时发生内部错误: ${error.message}`;
        // 尝试回退到安全状态或结束
        // currentState = 'FINISHED';
    }

    return aiReplyContent;
}

// --- Helper Function: Call Think Model with Search Handling ---
async function callThinkModelWithSearchHandling(messages, temperature, maxTokens) {
    console.log(`Calling ThinkModel (${thinkModel}) with potential search...`);
    let apiReply = await apiHelper.callApi(thinkModel, messages, temperature, maxTokens, true); // Enable search tool

    // Handle potential tool call (google_search) from ThinkModel
    // If the API is supposed to handle search internally, receiving a tool_call might be unexpected.
    // Log it for debugging, but don't try to execute it here. Assume the final reply should be content.
    if (apiReply.type === 'tool_call' && apiReply.tool_call.function.name === 'google_search') {
        const toolCall = apiReply.tool_call;
        const toolCallId = toolCall.id;
        let searchQuery = "Unknown query";
        try {
            const functionArgs = JSON.parse(toolCall.function.arguments);
            searchQuery = functionArgs.query || searchQuery;
        } catch (e) {
            // Ignore parsing error
        }
        console.warn(`ThinkModel unexpectedly requested tool call: google_search with query "${searchQuery}" (ID: ${toolCallId}). This might indicate an issue with the API's internal search handling.`);
        addMessageToHistory('system', `警告：模型 (ThinkModel) 意外请求外部 Google 搜索查询: "${searchQuery}"。API 应内部处理。`, 'system');
        // Return an error or a fallback message, as the expected content wasn't received.
        return { type: 'error', error: 'ThinkModel unexpectedly requested an external search instead of providing content.' };
    }

    // Return the final reply
    return apiReply;
}


// --- 状态处理函数 (修改以使用新 Helper) ---

async function handleInitialChat() {
    console.log('Workflow State: INITIAL_CHAT');
    // 与 NovaAI (ThinkModel) 交互
    const timePrefix = getFormattedTimePrompt();
    const initialMessages = [
        { role: 'system', content: timePrefix + deepResearchPrompt }, // 注入时间提示
        // 只发送用户和助手的历史记录给API
        ...conversationHistory.filter(m => m.role === 'user' || m.role === 'assistant')
    ];
    // 使用新的辅助函数调用 ThinkModel，允许搜索
    const aiReply = await callThinkModelWithSearchHandling(initialMessages, thinkModelTemp, thinkModelMaxTokens);

    if (aiReply.type === 'content') {
        // 只有最终的文本回复才加入对话历史的主干
        addMessageToHistory('assistant', aiReply.content, 'think');
        // 检查是否包含启动信号
        if (aiReply.content.includes('[[DeepResearchStart]]')) {
            console.log('Deep Research Started!');
            currentState = 'GENERATING_KEYWORDS';
            researchPlan = aiReply.content; // 保存研究计划
            // 触发关键词生成
            // 返回 NovaAI 的回复，并附加提示信息
            return `${aiReply.content}\n\n***\n研究流程已启动，正在生成关键词...`;
            // 注意：这里不直接调用 generateKeywords，而是让 server.js 在收到这个回复后，
            // 可能再次调用 handleMessage 来驱动流程进入 GENERATING_KEYWORDS 状态。
            // 或者，server.js 可以直接调用 generateKeywords。为简化，我们先假设 server.js 会处理。
            // **修改：** 为了让流程自动进行，这里直接调用下一个状态
            // return await generateKeywords(); // 这会导致前端收到关键词生成的最终结果，而不是 NovaAI 的回复
            // **折中：** 返回 NovaAI 的回复，并在 server 端检测到 [[DeepResearchStart]] 后再次调用 handleMessage
        }
        return aiReply.content; // 返回 NovaAI 的普通回复
    } else {
        console.error('Error in INITIAL_CHAT:', aiReply.error);
        return `抱歉，与 NovaAI 交流时出错: ${aiReply.error}`;
    }
}


async function generateKeywords() {
    console.log('Workflow State: GENERATING_KEYWORDS');
    if (!researchPlan) {
        console.error("Cannot generate keywords without a research plan.");
        currentState = 'INITIAL_CHAT'; // 回退
        return "错误：无法生成关键词，缺少研究计划。";
    }

    // 准备给关键词生成器的消息 (FastModel)
    const timePrefix = getFormattedTimePrompt();
    const keywordGenMessages = [
        { role: 'system', content: timePrefix + choicePrompt }, // 注入时间提示
        { role: 'user', content: `这是研究计划，请根据此计划生成搜索关键词:\n${researchPlan}` }
    ];

    const keywordReply = await apiHelper.callApi(fastModel, keywordGenMessages, fastModelTemp, fastModelMaxTokens, false); // 生成关键词不需要搜索

    if (keywordReply.type === 'content') {
        // 不直接将生成器的原始输出加入 assistant 历史，而是作为内部信息处理
        accumulatedInfo.push({ role: 'system', content: `Keyword Generator Output:\n${keywordReply.content}` });
        console.log("Keyword Generator Output:", keywordReply.content);

        // 解析关键词
        const matches = keywordReply.content.match(/\[\[(.*?)\]\]/g);
        if (matches) {
            keywordsToSearch = matches.map(match => match.slice(2, -2).trim()).filter(kw => kw); // 提取并去重、去空
            keywordsToSearch = [...new Set(keywordsToSearch)]; // 去重
            console.log('Parsed keywords:', keywordsToSearch);
            if (keywordsToSearch.length > 0) {
                currentState = 'SEARCHING';
                // 触发第一次搜索
                return await performSearch(); // 直接开始搜索
            } else {
                 console.warn('Keyword generator did not produce any valid keywords.');
                 currentState = 'INITIAL_CHAT'; // 回到初始状态
                 return "关键词生成器未能生成有效的关键词。请检查研究计划或提示词。";
            }
        } else {
            console.warn('Could not parse keywords from:', keywordReply.content);
            currentState = 'INITIAL_CHAT';
            return "无法从关键词生成器的回复中解析出关键词。";
        }
    } else {
        console.error('Error generating keywords:', keywordReply.error);
        currentState = 'INITIAL_CHAT'; // 出错则回退
        return `生成关键词时出错: ${keywordReply.error}`;
    }
}

// --- 辅助函数：搜索单个关键词 ---
async function searchSingleKeyword(keyword) {
    console.log(`Starting search for: [[${keyword}]]`);
    addMessageToHistory('system', `开始搜索关键词: [[${keyword}]]`, 'system');

    const timePrefix = getFormattedTimePrompt();
    const searchMessages = [
        { role: 'system', content: timePrefix + realSearchPrompt.replace('[[keyword]]', `[[${keyword}]]`) }, // 注入时间提示
        { role: 'user', content: `用户最初的研究需求: ${conversationHistory.find(m => m.role === 'user')?.content || '未知'}\n请专门搜索关于 [[${keyword}]] 的信息。` }
    ];

    let searchApiReply = await apiHelper.callApi(fastModel, searchMessages, fastModelTemp, fastModelMaxTokens, true);
    let finalSearchResultText = `搜索 [[${keyword}]] 时发生错误。`; // Default

    // Handle potential tool call (google_search) from FastModel during search
    // Since the API is expected to handle search internally, receiving a tool_call here is an error/unexpected state.
    if (searchApiReply.type === 'tool_call' && searchApiReply.tool_call.function.name === 'google_search') {
        const toolCall = searchApiReply.tool_call;
        const toolCallId = toolCall.id;
        let searchQuery = keyword; // Default to the original keyword
        try {
            const functionArgs = JSON.parse(toolCall.function.arguments);
            searchQuery = functionArgs.query || keyword;
        } catch (e) {
           // Ignore parsing error
        }
        console.error(`FastModel unexpectedly requested tool call during search for [[${keyword}]]: google_search with query "${searchQuery}" (ID: ${toolCallId}). The API should have performed the search internally.`);
        addMessageToHistory('system', `错误：模型 (FastModel) 在搜索 [[${keyword}]] 时意外请求外部 Google 搜索查询: "${searchQuery}"。API 应内部处理。`, 'system');
        // Return an error result for this keyword
        return { keyword: keyword, result: `搜索 [[${keyword}]] 失败：模型意外请求外部工具调用，而不是返回搜索结果。` };
    }

    // Process final response (content or error)
    if (searchApiReply.type === 'content') {
        finalSearchResultText = searchApiReply.content;
        console.log(`Final search result for [[${keyword}]]: ${finalSearchResultText.substring(0, 100)}...`);
        addMessageToHistory('assistant', `关于 [[${keyword}]] 的搜索总结:\n${finalSearchResultText}`, 'fast');
    } else if (searchApiReply.type === 'error') {
        finalSearchResultText = `搜索 [[${keyword}]] 时出错: ${searchApiReply.error}`;
        console.error(finalSearchResultText);
        addMessageToHistory('system', finalSearchResultText, 'system');
    } else if (searchApiReply.type === 'tool_call') {
        console.warn(`Unexpected tool call after search for [[${keyword}]]: ${searchApiReply.tool_call.function.name}`);
        finalSearchResultText = `搜索 [[${keyword}]] 后收到非预期的工具调用请求。`;
        addMessageToHistory('system', finalSearchResultText, 'system');
    }

    return { keyword: keyword, result: finalSearchResultText }; // Return result associated with the keyword
}


// --- 重构后的并行搜索函数 ---
async function performSearch() {
    console.log('Workflow State: SEARCHING (Parallel)');

    const keywordsBatch = [...keywordsToSearch]; // Copy current keywords to process in this batch
    keywordsToSearch = []; // Clear the list for potential new keywords from judger

    if (keywordsBatch.length === 0) {
        console.log('No keywords in current batch. Moving to JUDGING_DEPTH.');
        currentState = 'JUDGING_DEPTH';
        // Since this function might be called automatically, return a message
        // that triggers the next step in server.js or directly call judgeDepth
        return `所有关键词已搜索完毕。正在进行深度判断...`;
        // return await judgeDepth(); // Alternative: directly call next state
    }

    console.log(`Starting parallel search for ${keywordsBatch.length} keywords: ${keywordsBatch.map(k => `[[${k}]]`).join(', ')}`);
    addMessageToHistory('system', `开始并行搜索 ${keywordsBatch.length} 个关键词: ${keywordsBatch.map(k => `[[${k}]]`).join(', ')}`, 'system');

    // Create an array of promises, each searching one keyword
    const searchPromises = keywordsBatch.map(keyword => searchSingleKeyword(keyword));

    try {
        // Wait for all search promises to complete
        const results = await Promise.all(searchPromises);

        console.log(`Completed parallel search for ${results.length} keywords.`);

        // Process and store results
        results.forEach(item => {
            if (!searchResults[item.keyword]) {
                searchResults[item.keyword] = [];
            }
            // Avoid adding duplicate results if the same keyword was somehow searched twice
            if (!searchResults[item.keyword].includes(item.result)) {
                 searchResults[item.keyword].push(item.result);
            }
        });

        // All searches in this batch are done, move to judging
        currentState = 'JUDGING_DEPTH';
        return `所有关键词 (${keywordsBatch.map(k => `[[${k}]]`).join(', ')}) 已搜索完毕。正在进行深度判断...`;
        // return await judgeDepth(); // Alternative

    } catch (error) {
        // Handle potential errors from Promise.all (e.g., if one promise rejects unexpectedly)
        // Note: searchSingleKeyword already handles API errors internally and returns an error message string.
        // This catch block is more for unexpected runtime errors in the Promise.all setup itself.
        console.error('Error during parallel search execution:', error);
        addMessageToHistory('system', `并行搜索过程中发生意外错误: ${error.message}`, 'system');
        // Even if errors occurred, proceed to judging with whatever results were gathered
        currentState = 'JUDGING_DEPTH';
        return `并行搜索过程中发生错误，但仍将尝试进行深度判断...`;
        // return await judgeDepth(); // Alternative
    }
}


async function judgeDepth() {
    researchLoopCount++; // 进入判断即增加循环计数
    console.log(`Workflow State: JUDGING_DEPTH (Loop ${researchLoopCount}/${deepLoopLimit})`);

    // 准备给深度判断器的消息 (ThinkModel)
    let collectedResultsText = "已收集到的搜索结果:\n";
    if (Object.keys(searchResults).length === 0) {
        collectedResultsText = "尚未收集到任何搜索结果。\n";
    } else {
        for (const keyword in searchResults) {
            collectedResultsText += `--- 关键词: [[${keyword}]] ---\n`;
            searchResults[keyword].forEach((result, index) => {
                // 限制每个结果的长度，避免上下文过长
                collectedResultsText += `结果 ${index + 1}:\n${result.substring(0, 1000)}${result.length > 1000 ? '...' : ''}\n\n`;
            });
        }
    }

    // ThinkModel 看完整的 conversationHistory
    const timePrefix = getFormattedTimePrompt();
    const judgeMessages = [
        { role: 'system', content: timePrefix.trim() }, // 时间提示作为第一个系统消息
        ...conversationHistory.filter(m => m.role === 'user' || m.role === 'assistant'), // 用户和助手的对话历史
        { role: 'system', content: `--- 当前汇总的搜索信息 ---\n${collectedResultsText}` }, // 搜索结果作为系统信息
        { role: 'user', content: deepJudgePrompt } // 将判断指令作为最后一个用户消息
    ];

    // 使用新的辅助函数调用 ThinkModel，允许搜索
    const judgeReply = await callThinkModelWithSearchHandling(judgeMessages, thinkModelTemp, thinkModelMaxTokens);

    if (judgeReply.type === 'content') {
        // 将判断器的最终输出加入历史
        addMessageToHistory('assistant', `深度判断器 (循环 ${researchLoopCount}):\n${judgeReply.content}`, 'think');

        // 优先检查循环上限
        if (researchLoopCount >= deepLoopLimit) {
            console.log(`Deep research loop limit (${deepLoopLimit}) reached. Forcing report generation.`);
            currentState = 'GENERATING_REPORT';
            // 返回判断内容，并附加达到上限的提示
            return `${judgeReply.content}\n\n***\n研究深度达到上限 (${researchLoopCount}/${deepLoopLimit})，强制生成最终报告...`;
        }

        // 如果未达上限，再检查模型的判断
        if (judgeReply.content.includes('[[DeepResearchEnd]]')) {
            console.log('Deep Research Ended by Judger.');
            currentState = 'GENERATING_REPORT';
            // 触发报告生成
            return `${judgeReply.content}\n\n***\n研究结束，正在生成最终报告...`;
            // return await generateReport();
        } else {
            // 判断器认为需要继续，并可能提供了新的关键词
            const matches = judgeReply.content.match(/\[\[(.*?)\]\]/g);
            if (matches) {
                const newKeywords = matches.map(match => match.slice(2, -2).trim()).filter(kw => kw);
                const uniqueNewKeywords = [...new Set(newKeywords)]; // 去重

                if (uniqueNewKeywords.length > 0) {
                    console.log('Judger requested further research with keywords:', uniqueNewKeywords);
                    keywordsToSearch.push(...uniqueNewKeywords); // 将新关键词加入待搜索列表
                    keywordsToSearch = [...new Set(keywordsToSearch)]; // 再次去重总列表
                    currentState = 'SEARCHING';
                    // 返回判断结果给用户，并提示将进行下一步搜索
                    return `${judgeReply.content}\n\n***\n将根据指示继续搜索新关键词: ${uniqueNewKeywords.map(k => `[[${k}]]`).join(', ')}...`;
                    // return await performSearch();
                } else {
                    console.warn('Judger requested further research but provided no valid new keywords.');
                     currentState = 'GENERATING_REPORT';
                     return `${judgeReply.content}\n\n***\n虽然判断需要深入，但未提供有效的新关键词，即将生成报告...`;
                    // return await generateReport();
                }
            } else {
                console.warn('Judger did not provide keywords or end signal. Assuming end.');
                 currentState = 'GENERATING_REPORT';
                 return `${judgeReply.content}\n\n***\n未检测到明确的结束信号或新的关键词，即将生成报告...`;
                // return await generateReport();
            }
        }
    } else {
        // Handle API errors returned by the helper function
        console.error('Error during depth judgment API call:', judgeReply.error);
        currentState = 'GENERATING_REPORT'; // Set state to attempt report generation on error
        // Return a message that signals progression towards report generation,
        // which should be caught by the server's auto-advance loop.
        return `***\n深度判断出错 (${judgeReply.error})，正在尝试生成最终报告...`;
    }
}

async function generateReport() {
    console.log('Workflow State: GENERATING_REPORT');
    currentState = 'GENERATING_REPORT'; // Ensure state is set

    try { // Add a comprehensive try-catch block for the entire function logic
        // 准备给报告生成器的消息 (ThinkModel)
        console.log('Preparing context for report generation...');
        let finalReportContext = "请根据以下用户需求和整个研究流程中收集到的信息，生成一份详尽、准确与客观的报告:\n\n";
        accumulatedInfo.forEach(msg => {
            // 格式化消息以便模型理解
            if (msg.role === 'user') {
                finalReportContext += `用户输入: ${msg.content}\n`;
            } else if (msg.role === 'assistant') {
                // Ensure content is not null before appending
                if (msg.content !== null && msg.content !== undefined) {
                    finalReportContext += `AI回复: ${msg.content}\n`;
                } else if (msg.tool_calls) {
                    // Optionally log tool calls if needed for context, keep it brief
                    finalReportContext += `(AI请求工具调用: ${msg.tool_calls[0]?.function?.name})\n`;
                }
            } else if (msg.role === 'system') {
                 finalReportContext += `(系统信息/流程步骤: ${msg.content})\n`;
            } else if (msg.role === 'tool') {
                 // Ensure content is not null before processing
                 const toolContentSummary = (msg.content !== null && msg.content !== undefined)
                     ? `${msg.content.substring(0, 500)}${msg.content.length > 500 ? '...' : ''}`
                     : '(无内容)';
                 finalReportContext += `(工具 ${msg.name} 返回结果: ${toolContentSummary})\n`;
            }
        });
        finalReportContext += "\n--- 请基于以上所有信息生成报告 ---";
        console.log(`Final report context length (approx chars): ${finalReportContext.length}`);

        const timePrefix = getFormattedTimePrompt();
        const reportMessages = [
            { role: 'system', content: timePrefix + paperGenerationPrompt }, // 注入时间提示
            { role: 'user', content: finalReportContext }
        ];

        console.log(`Calling API (${paperModel}) for report generation (Search Tool Disabled)...`); // 使用 PaperModel
        // 直接调用 apiHelper，使用 PaperModel 配置，并明确禁用搜索工具
        // 允许较长的报告生成时间
        const reportReply = await apiHelper.callApi(
            paperModel,             // 使用 PaperModel 名称
            reportMessages,
            paperModelTemp,         // 使用 PaperModel 温度
            paperModelMaxTokens,    // 使用 PaperModel maxTokens
            false                   // <--- 明确禁用搜索工具
        );

        if (reportReply.type === 'content') {
            console.log('Successfully generated report (potentially after search).');
            // 将最终报告加入历史
            const finalReportText = `最终报告:\n${reportReply.content}`;
            addMessageToHistory('assistant', finalReportText, 'think');
            latestReportContent = reportReply.content; // 存储报告内容供下载
            currentState = 'FINISHED'; // 标记流程结束
            // 返回给 server.js 的内容不变，server.js 会根据状态添加 reportReady 标记
            return `研究完成，这是生成的报告：\n\n${reportReply.content}`;
        } else {
            latestReportContent = null; // 清除旧报告（如果生成失败）
            // Handle API errors returned by apiHelper
            console.error('API Error during report generation:', reportReply.error);
            currentState = 'FINISHED'; // 即使报告生成失败，也结束流程
            return `抱歉，在生成最终报告时遇到了问题: ${reportReply.error}\n\n研究流程已结束。`;
        }

    } catch (error) {
        // Catch any unexpected errors during context preparation, API call, or response handling
        console.error('Unexpected error in generateReport function:', error);
        currentState = 'FINISHED'; // Ensure workflow finishes even on unexpected errors
        // Provide a generic but informative error message
        return `抱歉，生成报告时发生意外内部错误: ${error.message}\n\n研究流程已结束。`;
    }
}

// 重置工作流状态
function resetWorkflow() {
    currentState = 'INITIAL_CHAT';
    conversationHistory = [];
    researchPlan = null;
    keywordsToSearch = [];
    searchResults = {};
    accumulatedInfo = [];
    latestReportContent = null; // 重置时清除报告
    researchLoopCount = 0; // 重置循环计数器
    console.log('Workflow reset.');
    // 可能需要返回一个消息给前端
    return "新的研究会话已准备就绪。";
}

// 获取当前状态（可能用于调试或前端显示）
function getCurrentState() {
    return currentState;
}


// 新增：获取最新报告内容的函数
function getLatestReport() {
    return latestReportContent;
}

module.exports = { handleMessage, resetWorkflow, getCurrentState, getLatestReport };