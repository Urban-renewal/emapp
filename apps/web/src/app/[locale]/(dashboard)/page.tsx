import { getTranslations } from 'next-intl/server';

export default async function HomePage() {
  const t = await getTranslations('home');
  return (
    <div className="mx-auto max-w-2xl space-y-4 py-12 text-center">
      <h1 className="text-3xl font-bold">{t('title')}</h1>
      <p className="text-base text-muted-foreground">{t('welcome')}</p>
    </div>
  );
}
