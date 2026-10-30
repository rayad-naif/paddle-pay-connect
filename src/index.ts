import express from 'express';
import path from 'path';
import { config } from './config';
import { oauthRouter } from './routes/oauth';
import { settingsRouter } from './routes/settings';
import { checkoutRouter } from './routes/checkout';
import { queryRouter } from './routes/query';
import { paddleWebhookRouter } from './routes/paddleWebhooks';

const app = express();
app.disable('x-powered-by');

// Keep the raw body: Paddle and GHL webhook signatures are computed over the exact bytes.
app.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf;
    },
  }),
);

// Checkout and settings pages are loaded inside GHL iframes (including funnels on custom
// domains), so framing must be allowed from anywhere. Never send X-Frame-Options here.
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');
  next();
});

const publicDir = path.join(__dirname, '..', 'public');
app.get('/checkout', (_req, res) => res.sendFile(path.join(publicDir, 'checkout.html')));
app.get('/settings', (_req, res) => res.sendFile(path.join(publicDir, 'settings.html')));
app.use(express.static(publicDir));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use(oauthRouter);
app.use(settingsRouter);
app.use(checkoutRouter);
app.use(queryRouter);
app.use(paddleWebhookRouter);

// On Vercel the exported app runs as a function; locally we listen on a port.
if (!process.env.VERCEL) {
  app.listen(config.port, () => {
    console.log(`GHL × Paddle provider listening on :${config.port}`);
    console.log(`Install URL: ${config.appUrl}/oauth/install`);
  });
}

export default app;
