import Link from 'next/link';

export default function Home() {
  const modules = [
    { title: 'Expedition Planning', desc: 'AI-assisted planning and feasibility checks.', href: '/expedition', icon: '🗺️', color: 'bg-blue-500/10 border-blue-500/30' },
    { title: 'Cargo & Logistics', desc: 'End-to-end tracking with dynamic risk scoring.', href: '/cargo', icon: '📦', color: 'bg-amber-500/10 border-amber-500/30' },
    { title: 'Inventory Management', desc: 'Predictive analytics based on weather data.', href: '/inventory', icon: '🧊', color: 'bg-green-500/10 border-green-500/30' },
    { title: 'Personnel Tracking', desc: 'Live GPS monitoring and geofencing alerts.', href: '/personnel', icon: '👥', color: 'bg-cyan-500/10 border-cyan-500/30' },
    { title: 'Emergency Response', desc: 'Instant SOS and automated accountability.', href: '/emergency', icon: '🚨', color: 'bg-red-500/10 border-red-500/30' },
    { title: 'Live Scenario Demo', desc: 'Guided walkthrough of the system capabilities.', href: '/scenario', icon: '▶️', color: 'bg-purple-500/10 border-purple-500/30' }
  ];

  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-120px)] max-w-6xl mx-auto">
      <div className="text-center mb-12">
        <div className="text-6xl mb-6 inline-block pulse-dot w-20 h-20 flex items-center justify-center rounded-full bg-polar-800/50 border border-polar-600/50" style={{boxShadow: '0 0 30px rgba(123, 192, 237, 0.2)'}}>
          ❄️
        </div>
        <h1 className="text-5xl font-bold tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-polar-100 to-polar-400 mb-4">
          PRAHARI
        </h1>
        <p className="text-xl text-polar-300 max-w-2xl mx-auto font-light">
          Antarctic Logistics & Safety Intelligence Platform
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 w-full px-4">
        {modules.map((m, i) => (
          <Link href={m.href} key={i}>
            <div className={`glass-card p-6 h-full border ${m.color} hover:bg-polar-800/50 transition-all duration-300 group cursor-pointer`}>
              <div className="text-4xl mb-4 group-hover:scale-110 transition-transform">{m.icon}</div>
              <h2 className="text-xl font-bold text-white mb-2">{m.title}</h2>
              <p className="text-polar-400 text-sm">{m.desc}</p>
            </div>
          </Link>
        ))}
      </div>

      <div className="mt-16 grid grid-cols-4 gap-8 w-full px-4">
        {[
          { label: 'Active Expeditions', val: '3' },
          { label: 'Shipments in Transit', val: '12' },
          { label: 'Personnel Deployed', val: '45' },
          { label: 'System Status', val: '100% ONLINE', safe: true }
        ].map((stat, i) => (
          <div key={i} className="text-center">
            <div className={`text-2xl font-bold mb-1 ${stat.safe ? 'text-safe' : 'text-polar-100'}`}>{stat.val}</div>
            <div className="text-xs text-polar-500 uppercase tracking-wider">{stat.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
