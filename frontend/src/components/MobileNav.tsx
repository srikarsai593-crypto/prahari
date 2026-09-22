'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Menu, X } from 'lucide-react';

export function MobileNav() {
  const [isOpen, setIsOpen] = useState(false);

  const links = [
    { href: '/expedition', label: 'Expedition' },
    { href: '/cargo',      label: 'Cargo'      },
    { href: '/inventory',  label: 'Inventory'  },
    { href: '/personnel',  label: 'Personnel'  },
    { href: '/emergency',  label: 'Emergency'  },
    { href: '/scenario',   label: 'Live Scenario' },
  ];

  return (
    <div className="md:hidden flex items-center">
      <button 
        onClick={() => setIsOpen(!isOpen)}
        className="p-2 text-arctic-700 hover:bg-arctic-100 rounded-lg transition-colors focus:outline-none"
      >
        {isOpen ? <X size={24} /> : <Menu size={24} />}
      </button>

      {isOpen && (
        <div className="absolute top-[60px] left-4 right-4 bg-white/80 backdrop-blur-xl border border-arctic-200/50 rounded-2xl shadow-xl p-4 flex flex-col gap-2 z-50">
          {links.map(link => (
            <Link 
              key={link.href} 
              href={link.href}
              onClick={() => setIsOpen(false)}
              className="px-4 py-3 rounded-xl font-medium text-arctic-800 hover:bg-arctic-50 hover:text-arctic-900 transition-colors"
            >
              {link.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
