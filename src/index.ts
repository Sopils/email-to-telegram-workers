import PostalMime from 'postal-mime';
import { htmlToText } from 'html-to-text';

async function sendMessage(token, chat_id, msg, thread_id){
    // telegram消息限制4096字符，对过多的部分进行截断
    const MAX_TELEGRAM_MESSAGE_LENGTH = 4096;
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
	try {
        const rep = await fetch(telegramUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload)
        });
        return rep;
    } catch (e) {
        console.error('Failed to send message due to a network error:', e);
        // 在发生网络层错误时，返回一个表示失败的 Response 对象
        return new Response(JSON.stringify({ ok: false, description: "Network error" }), { status: 500 });
    }
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

    try {
        return await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
            method: 'POST',
            body: formData
        });
    } catch (e) {
        console.error(`Network error sending attachment ${attachment.filename || ''}:`, e);
        // 返回一个模拟的失败 Response，保持接口一致性
        return new Response(JSON.stringify({ ok: false, description: "Network error" }), { status: 500 });
    }
}

export default {
	async email(message, env, ctx): Promise<void> {
	    // 先转发以免后续未知的错误导致转发出现问题
	    if(env.FORWARDING_EMAIL){
            ctx.waitUntil(message.forward(env.FORWARDING_EMAIL));
        }
        
        //cloudflare免费版有内存大小限制，如果邮件过大使用PostalMime会直接崩溃
        const MAX_ATTACHMENT_SIZE_BYTES = 128 * 1024 * 1024;
	    if(message.size > DANGEROUS_EMAIL_SIZE_BYTES){
	        console.error(`Email from ${message.from} dropped due to excessive size: ${(message.size / 1024 / 1024).toFixed(2)} MB`);
	        await sendMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, `来自${email.from.address}的消息过大转发失败，请登录邮箱查看具体邮件`, THREAD_ID);
	        return;
	    }
        
		const email = await PostalMime.parse(message.raw);

		// 为每封邮件生成唯一 ID
		const mailId = `#${crypto.randomUUID().toString().slice(2, 8)}`;

		const telegramMessage = `
${mailId}
From: ${email.from.address} (${email.from.name || 'No Name'})
To: ${email.to ? email.to.map(addr => addr.address).join(', ') : 'No To Address'}
Subject: ${email.subject}

${email.text ?? htmlToText(email.html ?? '')}
		`;
		
		const TELEGRAM_BOT_TOKEN = env.BOT_TOKEN;
		const TELEGRAM_CHAT_ID = env.CHAT_ID;
		const THREAD_ID = env.THREAD_ID || null; // 支持一下super_group的topic特性

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
		if (email.attachments && email.attachments.length > 0) {
            const replyParameters = messageId ? { message_id: messageId } : null;
            const attachmentUploadPromises = email.attachments.map(async (attachment) => {
                const caption = `${mailId}\n${attachment.filename || 'Attachment'}`;
                const docResponse = await sendDocument(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, THREAD_ID, replyParameters, caption, attachment);
                
                if (!docResponse.ok) {
                    console.error(`Failed to send attachment ${attachment.filename || ''}`, await docResponse.text());
                    await sendMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, `来自${email.from.address}的附件 ${attachment.filename || '之一'} 转发失败了，请登录邮箱查看具体邮件`, THREAD_ID);
                }
        });

            await Promise.all(attachmentUploadPromises);
        }
		console.log(email);
	}
} satisfies ExportedHandler<Env>;
