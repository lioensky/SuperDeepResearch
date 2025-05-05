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

    const requestBody = {
        model: modelName,
        messages: messages,
        temperature: temperature,
        max_tokens: maxTokens,
        // stream: false, // 暂时不使用流式传输
    };

    // 根据需要添加工具 (如果 useSearchTool 为 true)
    // 注意：这里的工具定义需要与 Gemini API 的 WebSearchFunctionTool 匹配
    // 具体的 'google_search' 名称和参数结构可能需要根据实际 API 文档调整
    if (useSearchTool) { // 移除 modelName === process.env.FastModel 的限制
        requestBody.tools = [
            {
                type: "function",
                function: {
                    name: "google_search", // 假设这是 Gemini API WebSearchFunctionTool 的名称
                    description: "Performs a Google search and returns results.",
                    parameters: { // 参数结构可能需要调整
                        type: "object",
                        properties: {
                            query: {
                                type: "string",
                                description: "The search query."
                            }
                        },
                        required: ["query"]
                    }
                }
            }
        ];
        requestBody.tool_choice = "auto"; // 让模型决定何时使用工具
    }

    console.log(`Calling API: ${modelName} with ${messages.length} messages. Use Search: ${useSearchTool}`);
    // console.log('Request Body:', JSON.stringify(requestBody, null, 2)); // Debugging

    try {
        const response = await axios.post(`${API_URL}/v1/chat/completions`, requestBody, { headers });

        // console.log('API Response:', JSON.stringify(response.data, null, 2)); // Debugging

        if (response.data && response.data.choices && response.data.choices.length > 0) {
            const choice = response.data.choices[0];
            const message = choice.message;

            if (message.tool_calls && message.tool_calls.length > 0) {
                // 检测到工具调用 (例如 google_search)
                console.log(`Tool call detected: ${message.tool_calls[0].function.name}`);
                return { type: 'tool_call', tool_call: message.tool_calls[0] }; // 返回第一个工具调用信息
            } else if (message.content) {
                // 普通文本响应
                return { type: 'content', content: message.content.trim() };
            } else {
                console.warn('API response choice message has no content or tool_calls:', choice);
                return { type: 'error', error: 'Unexpected API response format (no content/tool_call).' };
            }
        } else {
            console.error('Invalid API response structure:', response.data);
            return { type: 'error', error: 'Invalid API response structure.' };
        }
    } catch (error) {
        console.error('Error calling API:', error.response ? error.response.data : error.message);
        const errorMessage = error.response?.data?.error?.message || error.message || 'Unknown API error';
        return { type: 'error', error: `API call failed: ${errorMessage}` };
    }
}

module.exports = { callApi };