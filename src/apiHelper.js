const axios = require('axios');

// 从环境变量加载配置
const API_URL = process.env.API_URL;
const API_Key = process.env.API_Key;

/**
 * 调用 OpenAI 兼容的聊天 API
 * @param {string} modelName 模型名称 (e.g., 'gemini-2.5-pro-exp-03-25')
 * @param {Array<object>} messages 聊天消息历史 (e.g., [{ role: 'user', content: 'Hello' }])
 * @param {number} temperature 温度参数
 * @param {number} maxTokens 最大生成 token 数
 * @param {boolean} useSearchTool 是否启用搜索工具 (针对 FastModel)
 * @returns {Promise<object>} 返回包含模型响应或错误的 Promise 对象
 *                          成功时: { type: 'content', content: '...' } 或 { type: 'tool_call', tool_call: {...} }
 *                          失败时: { type: 'error', error: '...' }
 */
async function callApi(modelName, messages, temperature, maxTokens, useSearchTool = false) {
    if (!API_URL || !API_Key) {
        console.error('API_URL or API_Key is missing in environment variables.');
        return { type: 'error', error: 'API configuration is missing.' };
    }

    const headers = {
        'Authorization': `Bearer ${API_Key}`,
        'Content-Type': 'application/json',
    };

    // --- First API Call ---
    const firstRequestBody = {
        model: modelName,
        messages: messages,
        temperature: temperature,
        max_tokens: maxTokens,
    };

    // Add tools definition ONLY if useSearchTool is true for the first call
    if (useSearchTool) {
        firstRequestBody.tools = [
            {
                type: "function",
                function: {
                    name: "google_search", // Tool name expected by the proxy/model
                    description: "Performs a Google search and returns results.",
                    parameters: {
                        type: "object",
                        properties: {
                            query: { type: "string", description: "The search query." }
                        },
                        required: ["query"]
                    }
                }
            }
        ];
        firstRequestBody.tool_choice = "auto";
    }

    console.log(`Calling API (1st call): ${modelName} with ${messages.length} messages. Use Search Tool: ${useSearchTool}`);
    // console.log('First Request Body:', JSON.stringify(firstRequestBody, null, 2));

    try {
        let response = await axios.post(`${API_URL}/v1/chat/completions`, firstRequestBody, { headers });
        // console.log('First API Response:', JSON.stringify(response.data, null, 2));

        if (!response.data || !response.data.choices || response.data.choices.length === 0) {
            console.error('Invalid API response structure (1st call):', response.data);
            return { type: 'error', error: 'Invalid API response structure (1st call).' };
        }

        const firstChoice = response.data.choices[0];
        const firstMessage = firstChoice.message;

        // --- Check for Tool Calls ---
        if (firstChoice.finish_reason === 'tool_calls' && firstMessage?.tool_calls) {
            console.log(`Tool call detected by API: ${firstMessage.tool_calls[0].function.name}. Preparing second call.`);

            const messagesForSecondCall = [
                ...messages, // Original messages
                firstMessage, // Assistant's message requesting tool call(s)
            ];

            // Add placeholder tool results for the second call
            for (const toolCall of firstMessage.tool_calls) {
                 if (toolCall.type === 'function' && toolCall.function.name === 'google_search') {
                     const toolCallId = toolCall.id;
                     const functionArgs = toolCall.function.arguments;
                     console.log(`Constructing tool result for call_id: ${toolCallId}, args: ${functionArgs}`);
                     messagesForSecondCall.push({
                         role: 'tool',
                         tool_call_id: toolCallId,
                         name: 'google_search',
                         // Content can be simple confirmation, proxy handles actual execution.
                         content: `[Tool call processed for google_search with args: ${functionArgs}]`,
                     });
                 }
            }

            // --- Second API Call ---
            const secondRequestBody = {
                model: modelName,
                messages: messagesForSecondCall,
                temperature: temperature,
                max_tokens: maxTokens,
                // DO NOT include 'tools' or 'tool_choice' in the second call
            };

            console.log(`Calling API (2nd call): ${modelName} with ${messagesForSecondCall.length} messages.`);
            // console.log('Second Request Body:', JSON.stringify(secondRequestBody, null, 2));

            response = await axios.post(`${API_URL}/v1/chat/completions`, secondRequestBody, { headers });
            // console.log('Second API Response:', JSON.stringify(response.data, null, 2));

            if (!response.data || !response.data.choices || response.data.choices.length === 0) {
                console.error('Invalid API response structure (2nd call):', response.data);
                return { type: 'error', error: 'Invalid API response structure (2nd call).' };
            }
            // Process the response from the second call
            const secondChoice = response.data.choices[0];
            if (secondChoice.message && secondChoice.message.content) {
                console.log('Received content response after second call.');
                return { type: 'content', content: secondChoice.message.content.trim() };
            } else {
                 console.warn('API response message after second call has no content:', secondChoice);
                 return { type: 'error', error: 'Unexpected API response format after second call (no content).' };
            }

        } else if (firstMessage?.content) {
            // Normal content response from the first call (no tool call needed)
             console.log('Received content response from first call.');
             return { type: 'content', content: firstMessage.content.trim() };
        } else {
             // Unexpected response from the first call
             console.warn('API response message from first call has no content or tool_calls:', firstChoice);
             return { type: 'error', error: 'Unexpected API response format from first call (no content/tool_call).' };
        }

    } catch (error) {
        console.error('Error calling API:', error.response ? JSON.stringify(error.response.data) : error.message);
        const errorMessage = error.response?.data?.error?.message || error.message || 'Unknown API error';
        return { type: 'error', error: `API call failed: ${errorMessage}` };
    }
}

module.exports = { callApi };