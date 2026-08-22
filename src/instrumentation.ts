export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { bootstrap } = await import('@/server/bootstrap');
    await bootstrap();
  }
}
