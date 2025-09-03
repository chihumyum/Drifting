export function StyleTest() {
  return (
    <div className="p-8 bg-red-500 text-white text-center">
      <h1 className="text-4xl font-bold mb-4">Style Test</h1>
      <p className="text-lg">If you can see this with red background and white text, Tailwind is working!</p>
      <div className="mt-4 grid grid-cols-3 gap-4">
        <div className="p-4 bg-blue-500 rounded-lg">Blue Box</div>
        <div className="p-4 bg-green-500 rounded-lg">Green Box</div>
        <div className="p-4 bg-purple-500 rounded-lg">Purple Box</div>
      </div>
    </div>
  );
}