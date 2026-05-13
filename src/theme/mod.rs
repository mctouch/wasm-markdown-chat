pub mod colors;
pub mod syntax;

use colors::ThemeColor;

#[derive(Clone)]
pub struct Theme {
    pub name: String,
    pub background: ThemeColor,
    pub surface: ThemeColor,
    pub text: ThemeColor,
    pub text_secondary: ThemeColor,
    pub accent: ThemeColor,
    pub code_bg: ThemeColor,
    pub code_text: ThemeColor,
    pub heading_colors: [ThemeColor; 6],
    pub link: ThemeColor,
    pub link_visited: ThemeColor,
    pub border: ThemeColor,
    pub quote_bar: ThemeColor,
    pub quote_bg: ThemeColor,
    pub user_bubble_bg: ThemeColor,
    pub assistant_bubble_bg: ThemeColor,
    pub syntax: syntax::SyntaxColors,
    pub font_size_base: f32,
    pub font_size_code: f32,
    pub line_height: f32,
    pub margin_paragraph: f32,
    pub margin_heading: f32,
    pub margin_code: f32,
    pub padding_code: f32,
    pub border_radius_code: f32,
    pub max_content_width: f32,
}

impl Theme {
    pub fn dark() -> Self {
        Self {
            name: "dark".into(),
            background: ThemeColor::new(0x1a, 0x1a, 0x1a, 0xff),
            surface: ThemeColor::new(0x22, 0x22, 0x22, 0xff),
            text: ThemeColor::new(0xe0, 0xe0, 0xe0, 0xff),
            text_secondary: ThemeColor::new(0x88, 0x88, 0x88, 0xff),
            accent: ThemeColor::new(0x58, 0xa6, 0xff, 0xff),
            code_bg: ThemeColor::new(0x2d, 0x2d, 0x2d, 0xff),
            code_text: ThemeColor::new(0xe0, 0xe0, 0xe0, 0xff),
            heading_colors: [
                ThemeColor::new(0xff, 0xff, 0xff, 0xff),
                ThemeColor::new(0xf0, 0xf0, 0xf0, 0xff),
                ThemeColor::new(0xe0, 0xe0, 0xe0, 0xff),
                ThemeColor::new(0xd0, 0xd0, 0xd0, 0xff),
                ThemeColor::new(0xc0, 0xc0, 0xc0, 0xff),
                ThemeColor::new(0xb0, 0xb0, 0xb0, 0xff),
            ],
            link: ThemeColor::new(0x58, 0xa6, 0xff, 0xff),
            link_visited: ThemeColor::new(0xbc, 0x8f, 0xf8, 0xff),
            border: ThemeColor::new(0x33, 0x33, 0x33, 0xff),
            quote_bar: ThemeColor::new(0x58, 0xa6, 0xff, 0xff),
            quote_bg: ThemeColor::new(0x22, 0x28, 0x33, 0xff),
            user_bubble_bg: ThemeColor::new(0x2d, 0x4a, 0x7a, 0xff),
            assistant_bubble_bg: ThemeColor::new(0x33, 0x33, 0x33, 0xff),
            syntax: syntax::SyntaxColors::default_dark(),
            font_size_base: 16.0,
            font_size_code: 14.0,
            line_height: 1.6,
            margin_paragraph: 12.0,
            margin_heading: 16.0,
            margin_code: 12.0,
            padding_code: 12.0,
            border_radius_code: 6.0,
            max_content_width: 800.0,
        }
    }
}
