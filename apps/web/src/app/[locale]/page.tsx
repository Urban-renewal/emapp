import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

export default function HomePage() {
  const t = useTranslations('home');

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 p-24">
      <h1 className="text-4xl font-bold text-center">{t('title')}</h1>
      <p className="text-lg text-muted-foreground text-center max-w-lg">{t('subtitle')}</p>
      <Button size="lg">{t('getStarted')}</Button>
    </main>
  );
}
