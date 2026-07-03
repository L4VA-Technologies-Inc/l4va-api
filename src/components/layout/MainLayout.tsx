import type { ReactNode } from 'react';

import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';

interface LayoutProps {
  children?: ReactNode;
}

const MainLayout = ({ children }: LayoutProps) => {
  return (
    <div>
      <Header />
      <main className="min-h-screen content-space-top">
        {/* <AlertBanner
          message="TapTools API is currently unavailable. Some asset pricing, wallet discovery, and market data features may be limited. We are monitoring the situation."
          type="warning"
        /> */}
        <div className="container mx-auto px-4 xl:px-0">{children}</div>
      </main>
      <Footer />
    </div>
  );
};

export default MainLayout;
