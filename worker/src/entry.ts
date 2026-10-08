import frontend from 'vinext/server/app-router-entry';
import { dashboardAuth } from './auth';
import { fetchApi, receiveEmail } from './index';
import { type Env } from './model';
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const result = await fetchApi(request, env, ctx);
    if (result) return result;
    try {
      await dashboardAuth(request, env);
    } catch {
      return new Response(
        'Your Mail HQ session could not be verified. Please sign in again through Cloudflare Access.',
        {
          status: 401,
          headers: { 'Cache-Control': 'no-store' },
        },
      );
    }
    if (new URL(request.url).pathname.startsWith('/_next/static/'))
      return env.ASSETS.fetch(request);
    const response = await frontend.fetch(request, env, ctx);
    const secured = new Response(response.body, response);
    secured.headers.set('X-Content-Type-Options', 'nosniff');
    secured.headers.set('Referrer-Policy', 'no-referrer');
    secured.headers.set('X-Frame-Options', 'DENY');
    secured.headers.set('Cache-Control', 'private, no-store');
    return secured;
  },
  email: receiveEmail,
} satisfies ExportedHandler<Env>;
