# frontend-design

This skill guides creation of distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics. Implement real working code with exceptional attention to aesthetic details and creative choices.

The user provides frontend requirements: a component, page, application, or interface to build. They may include context about the purpose, audience, or technical constraints.

## Project Override: OpenWork

When the target is OpenWork, follow the project design system instead of inventing a new visual language. OpenWork is not a playground for arbitrary aesthetic experimentation; it is a clean, professional product emphasizing trust, clarity, scannability, and generous whitespace with subtle depth cues.

For OpenWork work:
- Preserve the existing visual language across new pages and components.
- Prefer extending the shared UI patterns already present in the repo over introducing one-off treatments.
- Use TypeScript for new code and keep functions small and focused.
- Add comments only for genuinely complex logic; explain why, not what.

### OpenWork Visual Direction

- **Concept**: Clean, professional, trustworthy, and spacious.
- **Philosophy**: Communicate value visually through hierarchy, clarity, and interfaces that feel real rather than decorative.
- **Tone**: Refined and product-focused, not loud, novelty-first, or stylistically chaotic.

### OpenWork Color System

Use these tokens or their existing CSS-variable equivalents:
- **Background**: `#FFFFFF`
- **Surface**: `#F7F8FA`
- **Card**: `#FFFFFF`
- **Border**: `#E8EAED`
- **Border subtle**: `#F0F1F3`
- **Text primary**: `#1A1A2E`
- **Text secondary**: `#6B7280`
- **Text tertiary**: `#9CA3AF`
- **Text inverse**: `#FFFFFF`
- **Primary green**: `#43E660`
- **Primary brand**: `#2D2D2D`
- **Link blue**: `#3B82F6`
- **Warning amber**: `#F59E0B`
- **Info purple**: `#8B5CF6`
- **Success**: `#10B981`
- **Error**: `#EF4444`
- **Warning**: `#F59E0B`
- **Info**: `#3B82F6`

### OpenWork Typography

OpenWork is an explicit exception to any generic anti-Inter guidance:
- **Primary font**: `Inter, system-ui, -apple-system, sans-serif`
- **Display**: Inter with tighter tracking
- **Hero title**: 48px, weight 500, tracking -0.02em, line-height 1.15
- **Section title**: 28px, weight 600, tracking -0.01em
- **Subsection**: 20px, weight 600
- **Body large**: 18px, weight 400, line-height 1.6
- **Body**: 15px, weight 400, line-height 1.5
- **Small/label**: 13px, weight 500
- **Caption**: 12px, weight 500, uppercase, tracking 0.05em

### OpenWork Layout And Spacing

- Max content width: 1200px centered
- Use 2-column layouts where appropriate for content + visual structure
- Section spacing: 80px-100px vertical
- Card padding: 20px-24px
- Typical element gaps: 12px-16px
- Use the spacing scale consistently: 4, 8, 12, 16, 20, 24, 32, 48, 64, 80px
- Spacing must reinforce hierarchy; do not add arbitrary whitespace

### OpenWork Components

- **Buttons**: Primary buttons use `#2D2D2D` with white text, 8px radius, 12px 24px padding. Secondary buttons are white with a 1px border. Ghost buttons are text-forward. Link buttons use link styling only when they are actual links.
- **Cards**: White background, 1px border, 12px radius, 20px-24px padding.
- **Badges**: Rounded pill shape, 13px medium weight, low-opacity fill with matching text color.
- **Tooltips**: Always use the shared `ui/Tooltip` component for hover hints, helper text, and disabled-state explanations. Never use the native `title` attribute. Disabled buttons requiring tooltips should be wrapped so the wrapper receives hover events.

### OpenWork Interaction Rules

- The interface is flat. Do not add hover shadows, glow effects, or hover movement.
- Card hover states should change border color or background tint only.
- Do not use `transform: translateY()` or similar hover motion.
- Only true inline text links get underline treatments.
- Navigation links such as breadcrumbs and back links should darken on hover without underline or movement.
- Interactive controls should use subtle background or border changes, not link-like hover styles.
- Reserve link blue for actual hyperlinks and form focus rings.
- Use smooth color and border transitions, typically `0.2s ease`.

## Design Thinking

Before coding, understand the context and commit to a BOLD aesthetic direction:
- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick an extreme: brutally minimal, maximalist chaos, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric, soft/pastel, industrial/utilitarian, etc. There are so many flavors to choose from. Use these for inspiration but design one that is true to the aesthetic direction.
- **Constraints**: Technical requirements (framework, performance, accessibility).
- **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work - the key is intentionality, not intensity.

When working on OpenWork, reinterpret this section as disciplined product design thinking:
- Optimize for clarity, trust, hierarchy, and cohesion with the existing product.
- Distinctiveness should come from precision and consistency, not from importing an unrelated aesthetic.
- Novel visual ideas are acceptable only when they still fit the OpenWork design system.

Then implement working code (HTML/CSS/JS, React, Vue, etc.) that is:
- Production-grade and functional
- Visually striking and memorable
- Cohesive with a clear aesthetic point-of-view
- Meticulously refined in every detail

## Frontend Aesthetics Guidelines

Focus on:
- **Typography**: Choose typography that fits the product context. For OpenWork, use the defined Inter-based scale and hierarchy rather than introducing new font pairings.
- **Color & Theme**: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes.
- **Motion**: Use animations for effects and micro-interactions. Prioritize CSS-only solutions for HTML. Use Motion library for React when available. Focus on high-impact moments: one well-orchestrated page load with staggered reveals (animation-delay) creates more delight than scattered micro-interactions. Use scroll-triggering and hover states that surprise.
- **Spatial Composition**: Unexpected layouts. Asymmetry. Overlap. Diagonal flow. Grid-breaking elements. Generous negative space OR controlled density.
- **Backgrounds & Visual Details**: Create atmosphere and depth rather than defaulting to solid colors. Add contextual effects and textures that match the overall aesthetic. Apply creative forms like gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows, decorative borders, custom cursors, and grain overlays.

NEVER use generic AI-generated aesthetics like overused font families (Inter, Roboto, Arial, system fonts), cliched color schemes (particularly purple gradients on white backgrounds), predictable layouts and component patterns, and cookie-cutter design that lacks context-specific character.

For OpenWork specifically, apply a narrower rule:
- Do not introduce generic AI-generated patterns, but do keep the existing Inter-based typography, light surfaces, restrained accents, and flat component model because they are part of the established product language.
- Avoid decorative shadows, gratuitous gradients, novelty layouts, or animation-heavy treatments that conflict with the design system.

Interpret creatively and make unexpected choices that feel genuinely designed for the context. No design should be the same. Vary between light and dark themes, different fonts, different aesthetics. NEVER converge on common choices (Space Grotesk, for example) across generations.

For OpenWork, do not vary between radically different themes or font systems unless the user explicitly asks for a redesign. Default to the current light, clean, professional system.

**IMPORTANT**: Match implementation complexity to the aesthetic vision. Maximalist designs need elaborate code with extensive animations and effects. Minimalist or refined designs need restraint, precision, and careful attention to spacing, typography, and subtle details. Elegance comes from executing the vision well.

Remember: Claude is capable of extraordinary creative work. Don't hold back, show what can truly be created when thinking outside the box and committing fully to a distinctive vision.
