import PostalMime from 'postal-mime';
import { htmlToText } from 'html-to-text';
const EXCESSIVE_MAIL_SIZE_BYTES = 100 * 1024 * 1024;
const MAX_TELEGRAM_ATTACHMENT_SIZE_BYTES = 50 * 1024 * 1024;
const MAX_TELEGRAM_MESSAGE_LENGTH = 4096;

async function fetchWithRetry(url, options, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            // 尝试发起请求，如果成功则直接返回响应
            return await fetch(url, options);
        } catch (e) {
            // 捕获网络层错误
            console.error(`Attempt ${i + 1} of ${retries} failed with a network error:`, e.message);
            // 如果这是最后一次尝试，则抛出错误或返回一个表示失败的Response对象
            if (i === retries - 1) {
                console.error('All retry attempts failed.');
                // 为了与原有代码逻辑保持一致，返回一个模拟的失败Response
                return new Response(JSON.stringify({ ok: false, description: "Network error after multiple retries" }), { status: 500 });
            }
            // 等待指定的延迟时间后继续下一次重试
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

async function sendMessage(token, chat_id, msg, thread_id){
    // telegram消息限制4096字符，对过多的部分进行截断
    if (msg.length > MAX_TELEGRAM_MESSAGE_LENGTH) {
         msg = msg.substring(0, MAX_TELEGRAM_MESSAGE_LENGTH - 5) + '...';
    }
    const payload = {
		chat_id: chat_id,
		text: msg
	}
    if (thread_id) {
        payload.message_thread_id = thread_id;
    }
	const telegramUrl = `https://api.telegram.org/bot${token}/sendMessage`;
    return await fetchWithRetry(telegramUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload)
    });
}

async function sendDocument(token, chat_id, thread_id, reply_params, caption, attachment) {
    const formData = new FormData();
    formData.append('chat_id', chat_id);
    formData.append('caption', caption);

    if (thread_id) {
        formData.append('message_thread_id', thread_id);
    }
    if (reply_params) {
        formData.append('reply_parameters', JSON.stringify(reply_params));
    }

    const blob = new Blob([attachment.content], { type: attachment.mimeType || 'application/octet-stream' });
    formData.append('document', blob, attachment.filename || 'attachment');
    return await fetchWithRetry(`https://api.telegram.org/bot${token}/sendDocument`, {
        method: 'POST',
        body: formData
     });
}

/**
 * 在后台处理附件的函数。
 * @param {object} env - 环境变量.
 * @param {object} email - 解析后的邮件对象.
 * @param {string} mailId - 邮件的唯一ID.
 * @param {object | null} replyParameters - 回复参数，用于将附件回复到主消息.
 */
async function handleAttachments(env, email, mailId, replyParameters) {
    if (!email.attachments || email.attachments.length === 0) {
        return;
    }

    const TELEGRAM_BOT_TOKEN = env.BOT_TOKEN;
    const TELEGRAM_CHAT_ID = env.CHAT_ID;
    const THREAD_ID = env.THREAD_ID || null;

    const attachmentProcessingPromises = email.attachments.map(async (attachment) => {
        const attachmentSizeMB = (attachment.content.byteLength / 1024 / 1024).toFixed(2);
        const caption = `${mailId}\n${attachment.filename || 'Attachment'}`;

        if (attachment.content.byteLength > MAX_TELEGRAM_ATTACHMENT_SIZE_BYTES) {
            console.error(`Attachment "${attachment.filename || 'Unnamed'}" is too large (${attachmentSizeMB} MB), skipping.`);
            const oversizedAttachmentMessage = `${mailId}\n来自 ${email.from.address} 的附件 "${attachment.filename || '无名附件'}" (${attachmentSizeMB} MB) 因超过50MB大小限制而无法转发。`;
            await sendMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, oversizedAttachmentMessage, THREAD_ID);
            return; // 跳过此附件
        }

        const docResponse = await sendDocument(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, THREAD_ID, replyParameters, caption, attachment);
        if (!docResponse.ok) {
            const errorText = await docResponse.text();
            console.error(`Failed to send attachment ${attachment.filename || ''}:`, errorText);
            await sendMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, `${mailId}\n来自 ${email.from.address} 的附件 ${attachment.filename || '之一'} 转发失败了，请登录邮箱查看具体邮件`, THREAD_ID);
        }
    });

    // Promise.all 确保所有附件都处理完毕后，waitUntil 的 promise 才算完成
    await Promise.all(attachmentProcessingPromises);
    console.log(`Finished processing ${email.attachments.length} attachments for mail ${mailId}.`);
}


export default {
	async email(message, env, ctx): Promise<void> {
	    if (!env.BOT_TOKEN || !env.CHAT_ID) {
            console.error('CRITICAL ERROR: BOT_TOKEN or CHAT_ID environment variable is not set.');
            // 如果环境变量缺失，Worker 将无法工作，直接返回即可
            return;
        }
	    const TELEGRAM_BOT_TOKEN = env.BOT_TOKEN;
		const TELEGRAM_CHAT_ID = env.CHAT_ID;
		const THREAD_ID = env.THREAD_ID || null; // 支持一下super_group的topic特性
		let email;
		
	    // 先转发以免后续未知的错误导致转发出现问题
	    if(env.FORWARDING_email){
            ctx.waitUntil(message.forward(env.FORWARDING_email));
        }
		
        //cloudflare免费版有内存大小限制，如果邮件过大使用PostalMime会直接崩溃
	    if(message.size > EXCESSIVE_MAIL_SIZE_BYTES){
	        console.error(`email from ${message.from} dropped due to excessive size: ${(message.size / 1024 / 1024).toFixed(2)} MB`);
	        await sendMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, `来自${message.from}的邮件因体积过大而转发失败，请登录邮箱查看具体邮件`, THREAD_ID);
	        return;
	    }
        try {
            email = await PostalMime.parse(message.raw);
        } catch(e) {
            console.error('Failed to parse email:', e);
            await sendMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, `来自${message.from}的邮件解析失败，请登录邮箱查看具体邮件`, THREAD_ID);
            return ;
        }
        
        
		// 为每封邮件生成唯一 ID
		const mailId = `#${crypto.randomUUID().toString().slice(2, 8)}`;

		const telegramMessage = `
${mailId}
From: ${email.from.address} (${email.from.name || 'No Name'})
To: ${email.to ? email.to.map(addr => addr.address).join(', ') : 'No To Address'}
Subject: ${email.subject}

${email.text ?? htmlToText(email.html ?? '')}
		`;
		

        const response = await sendMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, telegramMessage, THREAD_ID);

		if (!response.ok) {
			console.error('Failed to send message to Telegram', await response.text());
			await sendMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, `来自${email.from.address}的消息转发失败了，请登录邮箱查看具体邮件`, THREAD_ID);
			return ;// 主邮件发送失败直接终止执行，不发附件
		}
		console.log('ok');


        // 定位之前发送消息的messageId
        let messageId;
        const sentMessageData = await response.json();
        // 增加一个检查，确保 result 和 message_id 存在 ，不存在就不走回复（仍然可以用ID找到主邮件）
        if (!sentMessageData.result || !sentMessageData.result.message_id) {
             console.error('Telegram API did not return a valid message_id.');
        } else {
            messageId = sentMessageData.result.message_id;
        }
        
		// 发送附件到 Telegram
		const replyParameters = messageId ? { message_id: messageId } : null;
		ctx.waitUntil(handleAttachments(env, email, mailId, replyParameters)); // 用ctx.waitUntil() 开子进程防止发送附件时间太长导致主进程超时而终止执行

	}
} satisfies ExportedHandler<Env>;
