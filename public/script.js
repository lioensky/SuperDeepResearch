const chatLog = document.getElementById('chat-log');
const userInput = document.getElementById('user-input');
const sendButton = document.getElementById('send-button');

// Function to add a message to the chat log
function addMessage(sender, text) {
    const messageDiv = document.createElement('div');
    messageDiv.classList.add('message', sender); // sender can be 'user', 'ai', or 'system'

    // Basic Markdown support (bold, italics) - can be expanded
    text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>'); // Bold
    text = text.replace(/\*(.*?)\*/g, '<em>$1</em>');     // Italics
    text = text.replace(/\n/g, '<br>'); // Convert newlines to <br>

    messageDiv.innerHTML = text;
    chatLog.appendChild(messageDiv);

    // Scroll to the bottom of the chat log
    chatLog.scrollTop = chatLog.scrollHeight;

    return messageDiv; // Return the created message element
}

// --- Function to add a download button ---
function addDownloadButton(parentElement) {
    const downloadButton = document.createElement('button');
    downloadButton.textContent = '下载报告 (.md)';
    downloadButton.classList.add('download-button'); // Add class for styling
    downloadButton.onclick = async () => {
        try {
            downloadButton.textContent = '正在准备下载...';
            downloadButton.disabled = true;

            const response = await fetch('/api/download-report');
            if (!response.ok) {
                throw new Error(`下载失败: ${response.statusText}`);
            }
            const reportContent = await response.text();

            // Create a Blob from the report content
            const blob = new Blob([reportContent], { type: 'text/markdown;charset=utf-8' });
            const url = URL.createObjectURL(blob);

            // Create a temporary link element and trigger download
            const link = document.createElement('a');
            link.href = url;
            link.download = 'research_report.md'; // Filename for download
            document.body.appendChild(link); // Append to body to make it clickable
            link.click();

            // Clean up
            document.body.removeChild(link);
            URL.revokeObjectURL(url);

            downloadButton.textContent = '下载报告 (.md)';
            downloadButton.disabled = false;

        } catch (error) {
            console.error('Error downloading report:', error);
            alert(`下载报告时出错: ${error.message}`);
            downloadButton.textContent = '下载失败，重试?';
            downloadButton.disabled = false;
        }
    };
    parentElement.appendChild(downloadButton); // Append button below the message
}


// Function to send message to the backend
async function sendMessage() {
    const messageText = userInput.value.trim();
    if (!messageText) return; // Don't send empty messages

    addMessage('user', messageText); // Display user message immediately
    userInput.value = ''; // Clear the input field
    userInput.focus(); // Keep focus on input

    try {
        // Send message to backend API
        console.log('Sending to backend:', messageText);
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: messageText })
        });

        if (!response.ok) {
            // Handle HTTP errors (like 500 Internal Server Error)
            const errorData = await response.json().catch(() => ({})); // Try to parse error JSON, default to empty object
            console.error('Error from backend:', response.status, errorData);
            addMessage('system', `抱歉，与服务器通信时出错 (${response.status}): ${errorData.error || '未知错误'}`);
            return; // Stop processing on error
        }

        const data = await response.json();
        console.log('Received from backend:', data);

        if (data.reply) {
             const aiMessageDiv = addMessage('ai', data.reply); // Display AI response and get the div
             // Check if the report is ready and add download button
             if (data.reportReady) {
                 addDownloadButton(aiMessageDiv);
             }
        } else {
             console.warn('Backend response missing "reply" field:', data);
             addMessage('system', '收到了来自服务器的无效响应。');
        }


    } catch (error) {
        // Handle network errors or other issues during fetch
        console.error('Error sending message or processing response:', error);
        addMessage('system', '抱歉，发送消息时出错。');
    }
}

// Event listeners
sendButton.addEventListener('click', sendMessage);
userInput.addEventListener('keypress', (event) => {
    // Send message on Enter key press (Shift+Enter for newline)
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault(); // Prevent default Enter behavior (newline)
        sendMessage();
    }
});

// Initial system message (already in HTML, but could be added here too)
// addMessage('system', '欢迎使用深度研究器！请输入您想研究的主题。');