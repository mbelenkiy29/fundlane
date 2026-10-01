import { unsubscribeNotification } from '@/lib/mca/notifications/service';
import { consumeRequestRateLimit, clientRateKey } from '@/lib/mca/auth';
import { apiError } from '@/lib/mca/errors';
export const runtime = 'nodejs';
const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'" };
/** GET is inert: email-link scanners must not unsubscribe recipients. */
export async function GET(request: Request) {
    const token = new URL(request.url).searchParams.get('token') ?? '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
        return new Response('Invalid notification link.', { status: 400, headers });
    return new Response(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Stop notifications</title><body><h1>Stop these notifications</h1><p>This stops scheduled notifications to this address from this company.</p><form method="post"><input type="hidden" name="token" value="${token}"><button type="submit">Stop notifications</button></form></body></html>`, { headers });
}
export async function POST(request: Request) {
    try {
        await consumeRequestRateLimit(clientRateKey(request, 'notification-unsubscribe'), 20);
        const length = Number(request.headers.get('content-length') ?? 0);
        if (length > 1000)
            return new Response('Invalid notification link.', { status: 400, headers });
        const data = await request.formData(), token = data.get('token');
        const changed = typeof token === 'string' && await unsubscribeNotification(token);
        return new Response(changed ? 'Scheduled notifications have been stopped.' : 'Invalid notification link.', { status: changed ? 200 : 400, headers });
    }
    catch (error) {
        return apiError(error);
    }
}
