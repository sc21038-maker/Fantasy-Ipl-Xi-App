import React from 'react';
export const metadata = {
title: 'Fantasy IPL — Multiplayer Auction & FPL',
description: 'Live Fantasy IPL Auction, Retention, Pitch Manager, and League Standings',
};
export default function RootLayout({
children,
}: {
children: React.ReactNode;
}) {
return (
<html lang="en">
<head>
{/* Loads Tailwind CSS so all utility classes render cleanly without extra config files */}
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body className="bg-slate-950 text-slate-100 antialiased">
{children}
</body>
</html>
);
}
